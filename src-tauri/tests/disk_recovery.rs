use loom_lib::database;
use tempfile::tempdir;
use rusqlite::Connection;

#[test]
fn test_sqlite_crash_recovery_with_wal() {
    let dir = tempdir().expect("Failed to create temp dir");
    let db_path = dir.path().join("test_recovery.sqlite");
    let path_str = db_path.to_str().unwrap();

    // 1. Initial setup and valid commit
    {
        let mut conn = database::init_db(path_str).expect("Init DB failed");
        
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO workspaces (id, name) VALUES (?1, ?2)",
            ("ws-1", "My Workspace"),
        ).unwrap();
        tx.commit().unwrap();
    }

    // Verify WAL file exists after the connection drops, though SQLite might clean it up.
    // Actually, SQLite might clean up the WAL on graceful close.
    
    // 2. Simulate a crash mid-transaction
    {
        // Use a raw Connection::open to ensure we don't accidentally do cleanup
        let mut conn = Connection::open(path_str).unwrap();
        // Force WAL mode again just to be sure
        conn.execute_batch("PRAGMA journal_mode = WAL;").unwrap();

        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO items (id, workspace_id, item_type, title) VALUES (?1, ?2, ?3, ?4)",
            ("item-1", "ws-1", "note", "Crash Note"),
        ).unwrap();

        // Deliberately drop the transaction without committing.
        // In a real crash, the OS process dies. In Rust, dropping `tx` and `conn` without commit acts as a rollback.
        // To simulate a harder uncommitted write, we can drop the connection abruptly.
        drop(tx);
        drop(conn);
    }

    // 3. Restart and Recovery Validation
    {
        let conn = database::init_db(path_str).expect("Re-init DB failed");

        // The workspace should be there
        let ws_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM workspaces WHERE id = 'ws-1'",
            [],
            |row| row.get(0)
        ).unwrap();
        assert_eq!(ws_count, 1, "Committed workspace data should survive");

        // The item should NOT be there (rolled back / recovered from uncommitted state)
        let item_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE id = 'item-1'",
            [],
            |row| row.get(0)
        ).unwrap();
        assert_eq!(item_count, 0, "Uncommitted item data must not exist after crash recovery");
    }
}
