use loom_lib::database;
use rusqlite::Connection;
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Phase 7 Performance Benchmark\n");

    let counts = [1_000, 10_000, 50_000];
    
    for count in counts {
        println!("======================================");
        println!("Benchmarking scale: {} items", count);
        
        // Use an in-memory DB to isolate variables
        let mut conn = Connection::open_in_memory()?;
        database::setup_schema(&conn)?;

        // Seed Workspace
        let ws_id = "ws_bench";
        conn.execute(
            "INSERT INTO workspaces (id, name) VALUES (?1, ?2)",
            (ws_id, "Benchmark Workspace"),
        )?;

        let start_seed = Instant::now();
        // Seed Items
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO items (id, workspace_id, item_type, title, metadata) 
                 VALUES (?1, ?2, ?3, ?4, ?5)"
            )?;
            for i in 0..count {
                stmt.execute((
                    format!("item_{}", i),
                    ws_id,
                    "task",
                    format!("Benchmark Item {}", i),
                    r#"{"project": "Bench", "done": false}"#,
                ))?;
            }
            
            // Seed Links (average 2 links per item = 2*count)
            let mut link_stmt = tx.prepare(
                "INSERT INTO links (source_id, target_id, relationship_type) 
                 VALUES (?1, ?2, ?3)"
            )?;
            for i in 0..count {
                let target1 = (i + 1) % count;
                let target2 = (i + 2) % count;
                link_stmt.execute((format!("item_{}", i), format!("item_{}", target1), "relates_to"))?;
                link_stmt.execute((format!("item_{}", i), format!("item_{}", target2), "relates_to"))?;
            }
        }
        tx.commit()?;
        println!("  - Seed time: {:?}", start_seed.elapsed());

        // 1. Measure BEFORE: N+1 Link queries
        // Simulates the old N+1 `get_links_safe` calls
        let start_n_plus_1 = Instant::now();
        let mut old_link_count = 0;
        let mut get_links_stmt = conn.prepare(
            "SELECT l.source_id, l.target_id, l.relationship_type, l.created_at \
             FROM links l \
             JOIN items s ON l.source_id = s.id \
             JOIN items t ON l.target_id = t.id \
             WHERE (l.source_id = ?1 OR l.target_id = ?1) \
               AND s.deleted = 0 AND t.deleted = 0"
        )?;
        
        for i in 0..count {
            let item_id = format!("item_{}", i);
            let mut rows = get_links_stmt.query([&item_id])?;
            while let Some(_) = rows.next()? {
                old_link_count += 1;
            }
        }
        let elapsed_n_plus_1 = start_n_plus_1.elapsed();
        println!("  - BEFORE (N+1 Links): {:?} for {} rows returned", elapsed_n_plus_1, old_link_count);

        // 2. Measure AFTER: Batched `get_all_links_safe`
        let start_batched = Instant::now();
        let mut new_link_count = 0;
        let mut get_all_links_stmt = conn.prepare(
            "SELECT l.source_id, l.target_id, l.relationship_type, l.created_at \
             FROM links l \
             JOIN items s ON l.source_id = s.id \
             JOIN items t ON l.target_id = t.id \
             WHERE s.workspace_id = ?1 AND t.workspace_id = ?1 \
               AND s.deleted = 0 AND t.deleted = 0"
        )?;
        let mut rows = get_all_links_stmt.query([ws_id])?;
        while let Some(_) = rows.next()? {
            new_link_count += 1;
        }
        let elapsed_batched = start_batched.elapsed();
        println!("  - AFTER (Batched Links): {:?} for {} rows returned", elapsed_batched, new_link_count);
        
        let speedup = if elapsed_batched.as_millis() > 0 {
            elapsed_n_plus_1.as_millis() as f64 / elapsed_batched.as_millis() as f64
        } else {
            0.0
        };
        println!("    -> Speedup: {:.1}x", speedup);

        // 3. Measure Search BEFORE: LIKE queries (Full table scan)
        let search_query = "%Benchmark Item 999%";
        let start_like = Instant::now();
        let mut like_count = 0;
        let mut like_stmt = conn.prepare(
            "SELECT id FROM items \
             WHERE workspace_id = ?1 AND deleted = 0 \
             AND (title LIKE ?2 OR metadata LIKE ?2) LIMIT 50"
        )?;
        let mut rows = like_stmt.query((ws_id, search_query))?;
        while let Some(_) = rows.next()? {
            like_count += 1;
        }
        let elapsed_like = start_like.elapsed();
        println!("  - BEFORE (LIKE Search): {:?} (found {})", elapsed_like, like_count);

        // 4. Measure Search AFTER: FTS5 MATCH
        let start_fts = Instant::now();
        let mut fts_count = 0;
        let mut fts_stmt = conn.prepare(
            "SELECT items.id FROM items \
             JOIN items_fts ON items.id = items_fts.item_id \
             WHERE items.workspace_id = ?1 AND items.deleted = 0 \
             AND items_fts MATCH ?2 LIMIT 50"
        )?;
        let fts_query = "\"Benchmark Item 999\"";
        let mut rows = fts_stmt.query((ws_id, fts_query))?;
        while let Some(_) = rows.next()? {
            fts_count += 1;
        }
        let elapsed_fts = start_fts.elapsed();
        println!("  - AFTER (FTS5 Search): {:?} (found {})", elapsed_fts, fts_count);
        let fts_speedup = if elapsed_fts.as_millis() > 0 {
            elapsed_like.as_millis() as f64 / elapsed_fts.as_millis() as f64
        } else {
            elapsed_like.as_micros() as f64 / elapsed_fts.as_micros().max(1) as f64
        };
        println!("    -> Speedup: {:.1}x", fts_speedup);
        println!("");
    }
    
    Ok(())
}
