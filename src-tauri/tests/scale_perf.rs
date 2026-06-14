use rusqlite::Connection;
use std::time::Instant;

fn setup_schema_before(conn: &Connection) {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        CREATE TABLE items (
            id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, item_type TEXT NOT NULL,
            title TEXT NOT NULL, metadata TEXT DEFAULT '{}', deleted BOOLEAN DEFAULT 0
        );
        CREATE TABLE links (
            source_id TEXT NOT NULL, target_id TEXT NOT NULL, relationship_type TEXT NOT NULL,
            PRIMARY KEY (source_id, target_id, relationship_type)
        );
        "#
    ).unwrap();
}

fn setup_schema_after(conn: &Connection) {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        CREATE TABLE items (
            id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, item_type TEXT NOT NULL,
            title TEXT NOT NULL, metadata TEXT DEFAULT '{}', deleted BOOLEAN DEFAULT 0
        );
        CREATE TABLE links (
            source_id TEXT NOT NULL, target_id TEXT NOT NULL, relationship_type TEXT NOT NULL,
            PRIMARY KEY (source_id, target_id, relationship_type)
        );
        CREATE INDEX idx_links_target ON links(target_id);
        
        CREATE VIRTUAL TABLE items_fts USING fts5(
            item_id UNINDEXED, title, item_type, tokenize = 'unicode61'
        );
        "#
    ).unwrap();
}

fn populate(conn: &mut Connection, num_items: usize) {
    let tx = conn.transaction().unwrap();
    let ws = "ws-1";
    for i in 0..num_items {
        let id = format!("item-{}", i);
        let title = if i % 100 == 0 { format!("Special Title {}", i) } else { format!("Item {}", i) };
        tx.execute("INSERT INTO items (id, workspace_id, item_type, title, metadata) VALUES (?1, ?2, 'note', ?3, '{}')", 
            rusqlite::params![id, ws, title]).unwrap();
        
        // FTS trigger logic manually for AFTER schema
        let _ = tx.execute("INSERT INTO items_fts (item_id, title, item_type) VALUES (?1, ?2, 'note')", rusqlite::params![id, title]);

        if i > 0 {
            let target = format!("item-{}", i - 1);
            tx.execute("INSERT INTO links (source_id, target_id, relationship_type) VALUES (?1, ?2, 'related')",
                rusqlite::params![id, target]).unwrap();
        }
    }
    tx.commit().unwrap();
}

#[test]
fn run_scale_test() {
    let scales = vec![1_000, 10_000, 50_000];

    for scale in scales {
        println!("\n--- SCALING TO {} ITEMS ---", scale);
        
        // BEFORE
        let mut conn_before = Connection::open_in_memory().unwrap();
        setup_schema_before(&conn_before);
        populate(&mut conn_before, scale);

        // BEFORE: N+1 Link Queries
        let start = Instant::now();
        let mut total_links = 0;
        let mut stmt = conn_before.prepare("SELECT source_id, target_id FROM links WHERE source_id = ?1 OR target_id = ?1").unwrap();
        for i in 0..scale {
            let id = format!("item-{}", i);
            let rows = stmt.query_map([id], |_| Ok(())).unwrap();
            for _ in rows { total_links += 1; }
        }
        println!("BEFORE (N+1 Links): {:?}", start.elapsed());

        // BEFORE: Triple LIKE Search
        let start = Instant::now();
        let mut matches = 0;
        let mut stmt = conn_before.prepare("SELECT id FROM items WHERE title LIKE '%Special%' OR item_type LIKE '%Special%' OR metadata LIKE '%Special%'").unwrap();
        let rows = stmt.query_map([], |_| Ok(())).unwrap();
        for _ in rows { matches += 1; }
        println!("BEFORE (Triple LIKE Search, {} matches): {:?}", matches, start.elapsed());


        // AFTER
        let mut conn_after = Connection::open_in_memory().unwrap();
        setup_schema_after(&conn_after);
        populate(&mut conn_after, scale);

        // AFTER: 1 Batched Link Query
        let start = Instant::now();
        let mut total_links = 0;
        let mut stmt = conn_after.prepare("SELECT source_id, target_id FROM links WHERE source_id IN (SELECT id FROM items WHERE workspace_id = 'ws-1') OR target_id IN (SELECT id FROM items WHERE workspace_id = 'ws-1')").unwrap();
        let rows = stmt.query_map([], |_| Ok(())).unwrap();
        for _ in rows { total_links += 1; }
        println!("AFTER (Batched Links): {:?}", start.elapsed());

        // AFTER: FTS Search
        let start = Instant::now();
        let mut matches = 0;
        let mut stmt = conn_after.prepare("SELECT item_id FROM items_fts WHERE items_fts MATCH 'Special*'").unwrap();
        let rows = stmt.query_map([], |_| Ok(())).unwrap();
        for _ in rows { matches += 1; }
        println!("AFTER (FTS Search, {} matches): {:?}", matches, start.elapsed());
    }
}
