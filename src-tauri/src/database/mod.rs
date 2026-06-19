use rusqlite::{Connection, Result};

// Current logical schema version. Bump when a structural migration is added below.
// Tracked via SQLite's PRAGMA user_version so a migration runs at most once and an
// imported/restored DB can be checked for compatibility.
pub const SCHEMA_VERSION: i64 = 2;

pub fn setup_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            item_type TEXT NOT NULL,
            title TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            user_pinned BOOLEAN DEFAULT 0,
            user_size_preference TEXT,
            metadata TEXT DEFAULT '{}',
            deleted BOOLEAN DEFAULT 0,
            status TEXT,
            priority TEXT,
            due TEXT,
            progress INTEGER,
            tag TEXT,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS links (
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            relationship_type TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (source_id, target_id, relationship_type),
            FOREIGN KEY(source_id) REFERENCES items(id) ON DELETE CASCADE,
            FOREIGN KEY(target_id) REFERENCES items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS mutation_ledger (
            id TEXT PRIMARY KEY,
            command_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            filename TEXT NOT NULL,
            extension TEXT,
            mime_type TEXT,
            size_bytes INTEGER,
            created_at INTEGER,
            modified_at INTEGER,
            favorite INTEGER DEFAULT 0,
            tags TEXT,
            FOREIGN KEY(id) REFERENCES items(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS dashboard_widgets (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            widget_type TEXT NOT NULL,
            x INTEGER NOT NULL,
            y INTEGER NOT NULL,
            w INTEGER NOT NULL,
            h INTEGER NOT NULL,
            hidden BOOLEAN DEFAULT 0,
            config TEXT,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        -- Automation execution history. SQLite is the sole truth for run logs.
        -- automation_id references an item of item_type 'automation' (no FK so a
        -- soft-deleted automation keeps its history for forensics).
        CREATE TABLE IF NOT EXISTS automation_executions (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            trigger_source TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            finished_at TEXT,
            duration_ms INTEGER,
            actions_executed INTEGER DEFAULT 0,
            last_completed_index INTEGER DEFAULT -1,
            output TEXT,
            error TEXT
        );
        -- Durable per-action progress log for an automation run. Written
        -- incrementally as each action commits (output on automation_executions is
        -- only the end-of-run summary, lost on crash), so a run interrupted mid-way
        -- still has an exact record of which actions ran. The (run_id, action_index)
        -- primary key doubles as an idempotency guard: an action is never executed
        -- twice for the same run, even if a retry path re-drives an existing run_id.
        CREATE TABLE IF NOT EXISTS automation_action_log (
            run_id TEXT NOT NULL,
            action_index INTEGER NOT NULL,
            action_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'DONE',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (run_id, action_index)
        );
        CREATE TABLE IF NOT EXISTS trash_ledger (
            id TEXT PRIMARY KEY,
            original_path TEXT NOT NULL,
            filename TEXT NOT NULL,
            deleted_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        -- Crash-safe file-operation ledger. A rename/encrypt/decrypt records its
        -- intent here (autocommit) BEFORE touching disk, and the row is deleted in
        -- the SAME transaction that commits the DB repoint. A surviving PENDING row
        -- therefore means the process died between the disk mutation and the DB
        -- commit; startup recovery finishes or rolls it back, preserving item id.
        CREATE TABLE IF NOT EXISTS pending_fs_ops (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            src_path TEXT NOT NULL,
            dest_path TEXT NOT NULL,
            op_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_exec_automation ON automation_executions(automation_id);
        CREATE INDEX IF NOT EXISTS idx_exec_started ON automation_executions(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_exec_status ON automation_executions(status);
        CREATE INDEX IF NOT EXISTS idx_items_type ON items(workspace_id, item_type, deleted);
        -- Phase 7: the links PK indexes source_id (leftmost) but NOT target_id, so any
        -- "edges touching X" query (get_links_safe, links.count) had to scan the table
        -- on the target side. Index it so both endpoints are O(log n).
        CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_id);
        -- Phase 7: scheduler last_attempt + prune both filter by automation_id and sort
        -- by started_at DESC. A composite serves both without a separate sort step.
        CREATE INDEX IF NOT EXISTS idx_exec_auto_started ON automation_executions(automation_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
        CREATE INDEX IF NOT EXISTS idx_items_priority ON items(priority);
        CREATE INDEX IF NOT EXISTS idx_items_due ON items(due);
        CREATE INDEX IF NOT EXISTS idx_items_tag ON items(tag);
        "#
    )?;

    // ── Phase 9: application-wide full-text search index (FTS5) ───────────────────
    // FTS5 over title, item_type, and a derived `content` column that folds in the
    // searchable text every item keeps inside its metadata JSON: note bodies, file
    // text indexed by `index_text_files`, tags, authors, folders, URLs, descriptions.
    //
    // The previous index covered only title + item_type, which silently dropped all
    // content/tag/metadata matching — "search everything" had degraded into a title
    // prefix matcher. We index a curated set of text-bearing keys (never the raw JSON
    // blob, which would pollute the index with structural keys like "color"/"icon").
    // Triggers recompute `content` on every write, guarded by json_valid() so a
    // malformed metadata blob can never abort an item insert/update.
    //
    // rusqlite's `bundled` SQLite ships with SQLITE_ENABLE_FTS5 + JSON1, so no extra
    // feature flag is needed.
    const FTS_KEYS: &[&str] = &[
        "full_text", "content", "body", "text", "description", "desc", "note",
        "summary", "excerpt", "url", "author", "creator", "artist", "studio",
        "folder", "kind", "project", "sub", "byline", "site_name", "status",
        "tags", "tag",
    ];
    // Build the `content` SQL expression for a given metadata source ("new" inside a
    // trigger, "items" inside the backfill SELECT).
    let fts_content = |src: &str| -> String {
        let inner = FTS_KEYS
            .iter()
            .map(|k| format!("coalesce(json_extract({src}.metadata,'$.{k}'),'')"))
            .collect::<Vec<_>>()
            .join(" || ' ' || ");
        format!("CASE WHEN json_valid({src}.metadata) THEN ({inner}) ELSE '' END")
    };

    // Migrate pre-Phase-9 indexes (no `content` column): drop + rebuild from scratch.
    // The FTS table is a pure derived index, so rebuilding it is always safe.
    let needs_rebuild: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master \
             WHERE type='table' AND name='items_fts' AND sql NOT LIKE '%content%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if needs_rebuild > 0 {
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS items_fts_ai; \
             DROP TRIGGER IF EXISTS items_fts_ad; \
             DROP TRIGGER IF EXISTS items_fts_au; \
             DROP TABLE IF EXISTS items_fts;",
        )?;
    }

    conn.execute_batch(&format!(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
            item_id UNINDEXED, title, item_type, content, tokenize = 'unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
            INSERT INTO items_fts(item_id, title, item_type, content)
            VALUES (new.id, new.title, new.item_type, {content});
        END;
        CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
            DELETE FROM items_fts WHERE item_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE ON items BEGIN
            DELETE FROM items_fts WHERE item_id = old.id;
            INSERT INTO items_fts(item_id, title, item_type, content)
            VALUES (new.id, new.title, new.item_type, {content});
        END;
        "#,
        content = fts_content("new"),
    ))?;

    // Backfill fresh or just-rebuilt indexes. Idempotent: only runs when the index is
    // empty but items exist; the triggers maintain it thereafter.
    let fts_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM items_fts", [], |r| r.get(0))
        .unwrap_or(0);
    let items_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap_or(0);
    if fts_count == 0 && items_count > 0 {
        conn.execute_batch(&format!(
            "INSERT INTO items_fts(item_id, title, item_type, content) \
             SELECT id, title, item_type, {content} FROM items;",
            content = fts_content("items"),
        ))?;
    }

    // Soft-migration: per-widget config payload (e.g. Custom Widget HTML).
    let _ = conn.execute("ALTER TABLE dashboard_widgets ADD COLUMN config TEXT", []);

    // Soft-migration: run-level progress index for crash-consistency tracking.
    let _ = conn.execute(
        "ALTER TABLE automation_executions ADD COLUMN last_completed_index INTEGER DEFAULT -1",
        [],
    );

    // Soft-migration: Add columns to existing DB if they are missing
    let _ = conn.execute("ALTER TABLE items ADD COLUMN user_pinned BOOLEAN DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE items ADD COLUMN user_size_preference TEXT", []);
    let _ = conn.execute("ALTER TABLE items ADD COLUMN metadata TEXT DEFAULT '{}'", []);
    let _ = conn.execute("ALTER TABLE items ADD COLUMN deleted BOOLEAN DEFAULT 0", []);

    // Soft-migration: Promote JSON fields
    let _ = conn.execute("ALTER TABLE items ADD COLUMN status TEXT", []);
    let _ = conn.execute("ALTER TABLE items ADD COLUMN priority TEXT", []);
    let _ = conn.execute("ALTER TABLE items ADD COLUMN due TEXT", []);
    let _ = conn.execute("ALTER TABLE items ADD COLUMN progress INTEGER", []);
    let _ = conn.execute("ALTER TABLE items ADD COLUMN tag TEXT", []);
    
    // Soft-migration: Create the dashboard_widgets table in existing DBs
    let _ = conn.execute(
        r#"CREATE TABLE IF NOT EXISTS dashboard_widgets (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            widget_type TEXT NOT NULL,
            x INTEGER NOT NULL,
            y INTEGER NOT NULL,
            w INTEGER NOT NULL,
            h INTEGER NOT NULL,
            hidden BOOLEAN DEFAULT 0,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );"#,
        []
    );

    // Stamp the schema version. Idempotent: existing DBs at version 0 (pre-stamp)
    // are brought up to the current version after the soft-migrations above run.
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if current < SCHEMA_VERSION {
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    }

    Ok(())
}

pub fn init_db(path: &str) -> Result<Connection> {
    let mut conn = Connection::open(path)?;

    // WAL mode and synchronous level MUST be set on the raw connection before any
    // transaction is opened — SQLite forbids changing journal_mode/synchronous inside
    // a transaction and will return "Safety level may not be changed inside a transaction".
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
    )?;

    // Check if we need to migrate by querying user_version
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);

    // If a migration is pending, backup the database first
    if current > 0 && current < SCHEMA_VERSION {
        let backup_path = format!("{}.bak.v{}", path, current);
        if let Err(e) = std::fs::copy(path, &backup_path) {
            eprintln!("WARNING: Failed to create pre-migration backup at {}: {}", backup_path, e);
        } else {
            println!("Created pre-migration backup at {}", backup_path);
        }
    }

    // Run schema setup and DDL migrations inside a transaction.
    let tx = conn.transaction()?;
    setup_schema(&tx)?;
    tx.commit()?;

    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn.execute("INSERT INTO workspaces (id, name) VALUES ('ws','W')", [])
            .unwrap();
        conn
    }

    fn insert_item(conn: &Connection, id: &str, ty: &str, title: &str, metadata: &str) {
        conn.execute(
            "INSERT INTO items (id, workspace_id, item_type, title, metadata) \
             VALUES (?1, 'ws', ?2, ?3, ?4)",
            rusqlite::params![id, ty, title, metadata],
        )
        .unwrap();
    }

    // Mirrors build_fts_match: a single quoted prefix term.
    fn search(conn: &Connection, term: &str) -> Vec<String> {
        let m = format!("\"{}\"*", term);
        let mut stmt = conn
            .prepare(
                "SELECT i.id FROM items_fts JOIN items i ON i.id = items_fts.item_id \
                 WHERE items_fts MATCH ?1 AND i.deleted = 0 ORDER BY rank",
            )
            .unwrap();
        let rows = stmt.query_map([m], |r| r.get::<_, String>(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    #[test]
    fn fts_indexes_title_content_tags_and_metadata() {
        let conn = mem();
        insert_item(&conn, "n1", "note", "Berserk thoughts", r#"{"folder":"Manga"}"#);
        // File body lives only in metadata.full_text (written by index_text_files).
        insert_item(&conn, "f1", "file", "readme.md", r#"{"full_text":"the quick brown fox"}"#);
        // Tag + author live in metadata.
        insert_item(&conn, "l1", "library", "Designing Data-Intensive Applications",
            r#"{"tags":"THESIS","author":"Kleppmann"}"#);

        assert_eq!(search(&conn, "berserk"), vec!["n1"]);   // title
        assert_eq!(search(&conn, "brown"), vec!["f1"]);     // metadata.full_text content
        assert_eq!(search(&conn, "thesis"), vec!["l1"]);    // tag
        assert_eq!(search(&conn, "kleppmann"), vec!["l1"]); // author metadata
    }

    #[test]
    fn fts_content_reindexes_on_metadata_update() {
        let conn = mem();
        insert_item(&conn, "f1", "file", "doc.txt", "{}");
        assert!(search(&conn, "photosynthesis").is_empty());
        // Index Text folds file body into metadata.full_text → AFTER UPDATE trigger.
        conn.execute("UPDATE items SET metadata = ?1 WHERE id = 'f1'",
            [r#"{"full_text":"notes about photosynthesis"}"#]).unwrap();
        assert_eq!(search(&conn, "photosynthesis"), vec!["f1"]);
    }

    #[test]
    fn fts_tolerates_malformed_metadata() {
        let conn = mem();
        // Invalid JSON must not abort the insert (json_valid guard) and title still indexes.
        insert_item(&conn, "x1", "note", "Valid Title", "{not json");
        assert_eq!(search(&conn, "valid"), vec!["x1"]);
    }
}
