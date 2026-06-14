use crate::AppState;
use serde_json::json;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

// Data Export ─ dumps every SQLite-backed entity (workspaces, items, links) to a
// single JSON file chosen through the native save dialog. Real file, real picker.
#[tauri::command]
pub async fn export_data(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    // Build the snapshot under a tight lock scope; the guard is dropped before the
    // dialog opens (never held across the blocking UI call).
    let json_string = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;

        let exported_at: String = conn
            .query_row("SELECT CURRENT_TIMESTAMP", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        let mut ws_stmt = conn
            .prepare("SELECT id, name, created_at FROM workspaces")
            .map_err(|e| e.to_string())?;
        let ws_rows = ws_stmt
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "created_at": r.get::<_, String>(2)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        let mut workspaces = Vec::new();
        for r in ws_rows {
            workspaces.push(r.map_err(|e| e.to_string())?);
        }

        let mut it_stmt = conn
            .prepare("SELECT id, workspace_id, item_type, title, created_at, user_pinned, user_size_preference, metadata FROM items")
            .map_err(|e| e.to_string())?;
        let it_rows = it_stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, bool>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, String>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for r in it_rows {
            let (id, ws, ty, title, created, pinned, size, meta_str) = r.map_err(|e| e.to_string())?;
            // Inline the metadata object so the export is human-readable, not an escaped string.
            let meta: serde_json::Value = serde_json::from_str(&meta_str).unwrap_or_else(|_| json!({}));
            items.push(json!({
                "id": id,
                "workspace_id": ws,
                "item_type": ty,
                "title": title,
                "created_at": created,
                "user_pinned": pinned,
                "user_size_preference": size,
                "metadata": meta,
            }));
        }

        let mut lk_stmt = conn
            .prepare("SELECT source_id, target_id, relationship_type, created_at FROM links")
            .map_err(|e| e.to_string())?;
        let lk_rows = lk_stmt
            .query_map([], |r| {
                Ok(json!({
                    "source_id": r.get::<_, String>(0)?,
                    "target_id": r.get::<_, String>(1)?,
                    "relationship_type": r.get::<_, String>(2)?,
                    "created_at": r.get::<_, String>(3)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        let mut links = Vec::new();
        for r in lk_rows {
            links.push(r.map_err(|e| e.to_string())?);
        }

        // Settings ─ key/value app config. Required for a faithful restore (theme,
        // master-vault flags, indexing prefs, etc.).
        let mut st_stmt = conn
            .prepare("SELECT key, value FROM settings")
            .map_err(|e| e.to_string())?;
        let st_rows = st_stmt
            .query_map([], |r| {
                Ok(json!({
                    "key": r.get::<_, String>(0)?,
                    "value": r.get::<_, String>(1)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        let mut settings = Vec::new();
        for r in st_rows {
            settings.push(r.map_err(|e| e.to_string())?);
        }

        // Dashboard widget layout ─ per-workspace grid placement + config payloads.
        let mut dw_stmt = conn
            .prepare("SELECT id, workspace_id, widget_type, x, y, w, h, hidden, config FROM dashboard_widgets")
            .map_err(|e| e.to_string())?;
        let dw_rows = dw_stmt
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "workspace_id": r.get::<_, String>(1)?,
                    "widget_type": r.get::<_, String>(2)?,
                    "x": r.get::<_, i64>(3)?,
                    "y": r.get::<_, i64>(4)?,
                    "w": r.get::<_, i64>(5)?,
                    "h": r.get::<_, i64>(6)?,
                    "hidden": r.get::<_, bool>(7)?,
                    "config": r.get::<_, Option<String>>(8)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        let mut dashboard_widgets = Vec::new();
        for r in dw_rows {
            dashboard_widgets.push(r.map_err(|e| e.to_string())?);
        }

        let payload = json!({
            "loom_export": true,
            "version": 2,
            "exported_at": exported_at,
            "workspaces": workspaces,
            "items": items,
            "links": links,
            "settings": settings,
            "dashboard_widgets": dashboard_widgets,
        });
        serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?
    };

    // Native save dialog. async command → runs off the main thread → blocking call is safe.
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name("loom-export.json")
        .blocking_save_file();

    match picked {
        Some(fp) => {
            let path = fp.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&path, json_string).map_err(|e| e.to_string())?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None), // user cancelled — no file written, no fake success
    }
}

// Backup ─ produces a consistent, standalone copy of the live SQLite database via
// `VACUUM INTO`, which captures all committed data regardless of WAL state.
#[tauri::command]
pub async fn backup_database(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("SQLite Database", &["db", "sqlite"])
        .set_file_name("loom-backup.db")
        .blocking_save_file();

    let dest = match picked {
        Some(fp) => fp.into_path().map_err(|e| e.to_string())?,
        None => return Ok(None), // cancelled
    };

    // VACUUM INTO refuses to overwrite. The dialog already confirmed overwrite intent.
    if dest.exists() {
        std::fs::remove_file(&dest).map_err(|e| e.to_string())?;
    }

    let dest_str = dest.to_string_lossy().to_string();
    let escaped = dest_str.replace('\'', "''");
    let sql = format!("VACUUM INTO '{}'", escaped);

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute_batch(&sql).map_err(|e| e.to_string())?;

    Ok(Some(dest_str))
}

// Import ─ the inverse of `export_data`. Reads a LOOM JSON export and merges it into
// the live DB inside one transaction. INSERT OR REPLACE keyed on primary keys makes
// re-import idempotent and lets a clean install be fully rehydrated. Restores:
// workspaces, items (incl. metadata + vault values), links, settings, dashboard layout.
// Reads both v1 (no settings/widgets) and v2 exports.
#[tauri::command]
pub async fn import_data(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();

    let path = match picked {
        Some(fp) => fp.into_path().map_err(|e| e.to_string())?,
        None => return Ok(None), // cancelled
    };

    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Not valid JSON: {e}"))?;

    if doc.get("loom_export").and_then(|v| v.as_bool()) != Some(true) {
        return Err("This file is not a LOOM export.".into());
    }
    let version = doc.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
    if version < 1 || version > 2 {
        return Err(format!("Unsupported export version {version}."));
    }

    // Whole merge runs in ONE transaction. A crash or any failing insert mid-import
    // rolls the entire thing back (SQLite discards an uncommitted WAL txn on the next
    // open), so an interrupted import can never leave a half-restored DB.
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (ws_count, it_count, lk_count) = import_into_tx(&tx, &doc)?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(Some(format!(
        "Imported {ws_count} workspaces, {it_count} items, {lk_count} links."
    )))
}

// The merge itself — pure DB, no dialog/AppHandle — so crash/atomicity behaviour is
// unit-testable. Returns (workspaces, items, links) inserted. Any Err propagates and
// the caller's transaction is dropped un-committed => full rollback, no partial state.
pub(crate) fn import_into_tx(
    tx: &rusqlite::Transaction,
    doc: &serde_json::Value,
) -> Result<(u32, u32, u32), String> {
    let arr = |key: &str| -> Vec<serde_json::Value> {
        doc.get(key)
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };
    let workspaces = arr("workspaces");
    let items = arr("items");
    let links = arr("links");
    let settings = arr("settings");
    let dashboard_widgets = arr("dashboard_widgets");

    let s = |v: &serde_json::Value, k: &str| -> String {
        v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
    };

    // Workspaces first (items FK them).
    let mut ws_count = 0u32;
    for w in &workspaces {
        tx.execute(
            "INSERT OR REPLACE INTO workspaces (id, name, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![s(w, "id"), s(w, "name"), s(w, "created_at")],
        ).map_err(|e| e.to_string())?;
        ws_count += 1;
    }

    // Items (metadata is an inline object in the export → re-serialize to a string).
    let mut it_count = 0u32;
    for it in &items {
        let meta = match it.get("metadata") {
            Some(m) if m.is_string() => m.as_str().unwrap().to_string(),
            Some(m) => serde_json::to_string(m).unwrap_or_else(|_| "{}".into()),
            None => "{}".to_string(),
        };
        let size: Option<String> = it.get("user_size_preference")
            .and_then(|x| x.as_str()).map(|x| x.to_string());
        // Upsert (not INSERT OR REPLACE): REPLACE would DELETE+INSERT and fire
        // ON DELETE CASCADE, wiping pre-existing local links to this item on a merge.
        tx.execute(
            "INSERT INTO items
                (id, workspace_id, item_type, title, created_at, user_pinned, user_size_preference, metadata, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)
             ON CONFLICT(id) DO UPDATE SET
                workspace_id=excluded.workspace_id, item_type=excluded.item_type,
                title=excluded.title, created_at=excluded.created_at,
                user_pinned=excluded.user_pinned, user_size_preference=excluded.user_size_preference,
                metadata=excluded.metadata, deleted=0",
            rusqlite::params![
                s(it, "id"), s(it, "workspace_id"), s(it, "item_type"), s(it, "title"),
                s(it, "created_at"),
                it.get("user_pinned").and_then(|x| x.as_bool()).unwrap_or(false),
                size, meta
            ],
        ).map_err(|e| e.to_string())?;
        it_count += 1;
    }

    // Links (both endpoints must already exist — items inserted above).
    let mut lk_count = 0u32;
    for l in &links {
        tx.execute(
            "INSERT OR IGNORE INTO links (source_id, target_id, relationship_type, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                s(l, "source_id"), s(l, "target_id"),
                s(l, "relationship_type"), s(l, "created_at")
            ],
        ).map_err(|e| e.to_string())?;
        lk_count += 1;
    }

    // Settings (v2+).
    for st in &settings {
        tx.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![s(st, "key"), s(st, "value")],
        ).map_err(|e| e.to_string())?;
    }

    // Dashboard layout (v2+).
    for d in &dashboard_widgets {
        let i = |k: &str| d.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
        let config: Option<String> = d.get("config").and_then(|x| x.as_str()).map(|x| x.to_string());
        tx.execute(
            "INSERT OR REPLACE INTO dashboard_widgets
                (id, workspace_id, widget_type, x, y, w, h, hidden, config)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                s(d, "id"), s(d, "workspace_id"), s(d, "widget_type"),
                i("x"), i("y"), i("w"), i("h"),
                d.get("hidden").and_then(|x| x.as_bool()).unwrap_or(false),
                config
            ],
        ).map_err(|e| e.to_string())?;
    }

    Ok((ws_count, it_count, lk_count))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::database::setup_schema(&c).unwrap();
        c
    }

    // ── Import is atomic: a failing row mid-merge rolls back EVERYTHING ──────────
    // A dashboard widget pointing at a non-existent workspace trips the FK late in the
    // merge. The items inserted earlier in the same txn must NOT survive.
    #[test]
    fn import_is_all_or_nothing_on_failure() {
        let mut c = db();
        let doc = json!({
            "loom_export": true, "version": 2,
            "workspaces": [{ "id": "ws1", "name": "W", "created_at": "t" }],
            "items": [{ "id": "i1", "workspace_id": "ws1", "item_type": "task", "title": "T",
                        "created_at": "t", "user_pinned": false, "metadata": {} }],
            // FK violation: widget references a workspace that was never inserted.
            "dashboard_widgets": [{ "id": "w1", "workspace_id": "GHOST", "widget_type": "x",
                                    "x": 0, "y": 0, "w": 1, "h": 1, "hidden": false }],
        });
        {
            let tx = c.transaction().unwrap();
            let res = import_into_tx(&tx, &doc);
            assert!(res.is_err(), "FK violation must surface as Err");
            // Drop the tx WITHOUT commit — models the command bailing / a crash.
            drop(tx);
        }
        let items: i64 = c.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        let ws: i64 = c.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0)).unwrap();
        assert_eq!((items, ws), (0, 0), "partial import fully rolled back");
    }

    // ── Re-import is idempotent: same export twice = same state, no duplicates ────
    #[test]
    fn reimport_is_idempotent() {
        let mut c = db();
        let doc = json!({
            "loom_export": true, "version": 2,
            "workspaces": [{ "id": "ws1", "name": "W", "created_at": "t" }],
            "items": [{ "id": "i1", "workspace_id": "ws1", "item_type": "task", "title": "T",
                        "created_at": "t", "user_pinned": false, "metadata": {"k": 1} }],
            "links": [],
        });
        for _ in 0..2 {
            let tx = c.transaction().unwrap();
            import_into_tx(&tx, &doc).unwrap();
            tx.commit().unwrap();
        }
        let items: i64 = c.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(items, 1, "upsert keyed on id — re-import does not duplicate");
        let meta: String = c.query_row("SELECT metadata FROM items WHERE id='i1'", [], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&meta).unwrap()["k"], json!(1));
    }

    // ── Merge import preserves pre-existing local links to a re-imported item ─────
    // The upsert (not REPLACE) must NOT cascade-delete an inbound link the local DB
    // already had for an item that also appears in the export.
    #[test]
    fn merge_import_keeps_local_links() {
        let mut c = db();
        c.execute("INSERT INTO workspaces (id, name) VALUES ('ws1','W')", []).unwrap();
        c.execute("INSERT INTO items (id, workspace_id, item_type, title, metadata) VALUES ('a','ws1','note','A','{}')", []).unwrap();
        c.execute("INSERT INTO items (id, workspace_id, item_type, title, metadata) VALUES ('b','ws1','note','B','{}')", []).unwrap();
        c.execute("INSERT INTO links (source_id, target_id, relationship_type) VALUES ('a','b','related')", []).unwrap();

        // Export re-introduces item 'b' (e.g. an updated copy). Local link a→b must survive.
        let doc = json!({
            "loom_export": true, "version": 2,
            "items": [{ "id": "b", "workspace_id": "ws1", "item_type": "note", "title": "B2",
                        "created_at": "t", "user_pinned": false, "metadata": {} }],
        });
        let tx = c.transaction().unwrap();
        import_into_tx(&tx, &doc).unwrap();
        tx.commit().unwrap();

        let links: i64 = c.query_row("SELECT COUNT(*) FROM links WHERE source_id='a' AND target_id='b'", [], |r| r.get(0)).unwrap();
        assert_eq!(links, 1, "upsert must not cascade-wipe the pre-existing local link");
        let title: String = c.query_row("SELECT title FROM items WHERE id='b'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "B2", "item fields still updated by the import");
    }
}
