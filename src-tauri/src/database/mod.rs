use rusqlite::{Connection, Result};

// Current logical schema version. Bump when a structural migration is added below.
// Tracked via SQLite's PRAGMA user_version so a migration runs at most once and an
// imported/restored DB can be checked for compatibility.
pub const SCHEMA_VERSION: i64 = 1;

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
        "#
    )?;

    // ── Phase 7: full-text search index (FTS5) ────────────────────────────────────
    // Standalone FTS5 table over item title + type (metadata is intentionally NOT
    // indexed — it is large JSON and was the worst offender in the old triple-LIKE
    // scan). Triggers keep it in lockstep with `items` regardless of which Rust path
    // writes the row, so search never falls back to a full-table scan. Soft-deletes
    // stay in the index and are filtered at query time via a join on items.deleted.
    // rusqlite's `bundled` SQLite ships with SQLITE_ENABLE_FTS5, so no extra feature
    // flag is needed.
    conn.execute_batch(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
            item_id UNINDEXED, title, item_type, tokenize = 'unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
            INSERT INTO items_fts(item_id, title, item_type) VALUES (new.id, new.title, new.item_type);
        END;
        CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
            DELETE FROM items_fts WHERE item_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE ON items BEGIN
            DELETE FROM items_fts WHERE item_id = old.id;
            INSERT INTO items_fts(item_id, title, item_type) VALUES (new.id, new.title, new.item_type);
        END;
        "#,
    )?;
    // One-time backfill for DBs that pre-date the FTS index. Idempotent: only runs
    // when the index is empty but items exist; the triggers maintain it thereafter.
    let fts_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM items_fts", [], |r| r.get(0))
        .unwrap_or(0);
    let items_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap_or(0);
    if fts_count == 0 && items_count > 0 {
        conn.execute(
            "INSERT INTO items_fts(item_id, title, item_type) SELECT id, title, item_type FROM items",
            [],
        )?;
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
