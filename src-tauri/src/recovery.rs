// ─────────────────────────────────────────────────────────────────────────────
// Recovery — deletion history + whole-workspace snapshots/rollback.
//
// Two recovery-first surfaces, both backed by SQLite (the architecture's single
// source of truth):
//
//   1. Deletion history. Soft-deleted items stay in the `items` table (deleted=1).
//      We list them with a best-effort deletion timestamp recovered from the
//      mutation_ledger, and restore one by flipping the flag back (plus pulling its
//      blob out of the trash dir if it was a file/note).
//
//   2. Workspace snapshots. `capture_snapshot` serialises every item + link of a
//      workspace into workspace_snapshots.payload. `restore_workspace_snapshot`
//      re-applies that state: items are UPSERTed (soft-delete flag included), items
//      created since the snapshot are soft-deleted, and links are rebuilt. It never
//      hard-deletes, so file rows and on-disk blobs survive a rollback. A safety
//      snapshot of the current state is auto-captured before every rollback.
// ─────────────────────────────────────────────────────────────────────────────

use crate::commands::{execute_two_phase, Link};
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

// ── Deletion history ──────────────────────────────────────────────────────────
#[derive(Serialize, Debug)]
pub struct DeletedItem {
    pub id: String,
    pub workspace_id: String,
    pub item_type: String,
    pub title: String,
    pub metadata: String,
    /// Best-effort deletion time, recovered from the mutation ledger. None if the
    /// item was soft-deleted before the ledger existed (legacy data).
    pub deleted_at: Option<String>,
}

pub(crate) fn deletion_history(
    conn: &rusqlite::Connection,
    workspace_id: &str,
) -> Result<Vec<DeletedItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.workspace_id, i.item_type, i.title, i.metadata, \
                (SELECT ml.created_at FROM mutation_ledger ml \
                   WHERE ml.status = 'COMMITTED' \
                     AND ml.command_type IN ('delete_item','automation_delete') \
                     AND ml.payload LIKE '%' || i.id || '%' \
                   ORDER BY ml.created_at DESC LIMIT 1) AS deleted_at \
             FROM items i \
             WHERE i.deleted = 1 AND i.workspace_id = ?1 \
             ORDER BY deleted_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([workspace_id], |r| {
            Ok(DeletedItem {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                item_type: r.get(2)?,
                title: r.get(3)?,
                metadata: r.get(4)?,
                deleted_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_deletion_history(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<DeletedItem>, String> {
    state
        .db
        .call(move |conn| Ok(deletion_history(conn, &workspace_id)))
        .await
        .map_err(|e| e.to_string())
        .and_then(|x| x)
}

#[tauri::command]
pub async fn restore_deleted_item(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    id: String,
) -> Result<crate::commands::DeletedId, String> {
    state
        .db
        .call(move |mut conn| {
            let res = (|| -> Result<_, String> {
                // Pull the original on-disk path (if any) so a deleted file/note blob
                // comes back out of the trash dir alongside the row un-delete.
                let original_path: Option<String> = conn
                    .query_row(
                        "SELECT original_path FROM trash_ledger WHERE id = ?1 \
                         UNION SELECT path FROM files WHERE id = ?1 LIMIT 1",
                        [&id],
                        |r| r.get(0),
                    )
                    .ok();

                let mut staged_restore = false;
                if let Some(ref path) = original_path {
                    // Non-fatal: a file may have no trash blob (already on disk).
                    if crate::fs_commands::restore_file_from_trash(&app_handle, &id, path).is_ok() {
                        staged_restore = true;
                    }
                }

                let payload = format!(r#"{{"id":"{}"}}"#, id);
                let res = execute_two_phase(&mut conn, "restore_deleted_item", &payload, |tx| {
                    let changed = tx
                        .execute(
                            "UPDATE items SET deleted = 0 WHERE id = ?1 AND deleted = 1",
                            [&id],
                        )
                        .map_err(|e| e.to_string())?;
                    if changed == 0 {
                        return Err(format!("Item '{}' not found or not deleted", id));
                    }
                    tx.execute("DELETE FROM trash_ledger WHERE id = ?1", [&id])
                        .map_err(|e| e.to_string())?;
                    Ok(crate::commands::DeletedId { id: id.clone() })
                });

                match res {
                    Ok(v) => Ok(v),
                    Err(e) => {
                        if staged_restore {
                            if let Some(ref path) = original_path {
                                let _ = crate::fs_commands::move_file_to_trash(&app_handle, &id, path);
                            }
                        }
                        Err(e)
                    }
                }
            })();
            Ok(res)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|x| x)
}

// ── Workspace snapshots ───────────────────────────────────────────────────────
#[derive(Serialize, Deserialize, Debug, Clone)]
struct SnapshotItem {
    id: String,
    workspace_id: String,
    item_type: String,
    title: String,
    created_at: String,
    user_pinned: bool,
    user_size_preference: Option<String>,
    metadata: String,
    deleted: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct SnapshotPayload {
    items: Vec<SnapshotItem>,
    links: Vec<Link>,
}

/// Snapshot list-row (no payload — that can be megabytes).
#[derive(Serialize, Debug)]
pub struct SnapshotMeta {
    pub id: String,
    pub workspace_id: String,
    pub label: String,
    pub item_count: i64,
    pub link_count: i64,
    pub created_at: String,
}

// Serialise the full current state of a workspace and persist it. Shared by the
// explicit "take snapshot" command and the auto-backup taken before a rollback.
pub(crate) fn capture_snapshot(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    label: &str,
) -> Result<SnapshotMeta, String> {
    let mut item_stmt = conn
        .prepare(
            "SELECT id, workspace_id, item_type, title, created_at, user_pinned, \
                    user_size_preference, metadata, deleted \
             FROM items WHERE workspace_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let items: Vec<SnapshotItem> = item_stmt
        .query_map([workspace_id], |r| {
            Ok(SnapshotItem {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                item_type: r.get(2)?,
                title: r.get(3)?,
                created_at: r.get(4)?,
                user_pinned: r.get(5)?,
                user_size_preference: r.get(6)?,
                metadata: r.get(7)?,
                deleted: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // Every link with a source in this workspace (target may live elsewhere; restore
    // uses INSERT OR IGNORE so a cross-workspace edge is harmless).
    let mut link_stmt = conn
        .prepare(
            "SELECT l.source_id, l.target_id, l.relationship_type, l.created_at \
             FROM links l JOIN items s ON l.source_id = s.id \
             WHERE s.workspace_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let links: Vec<Link> = link_stmt
        .query_map([workspace_id], |r| {
            Ok(Link {
                source_id: r.get(0)?,
                target_id: r.get(1)?,
                relationship_type: r.get(2)?,
                created_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let item_count = items.len() as i64;
    let link_count = links.len() as i64;
    let payload = serde_json::to_string(&SnapshotPayload { items, links })
        .map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO workspace_snapshots (id, workspace_id, label, item_count, link_count, payload) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![id, workspace_id, label, item_count, link_count, payload],
    )
    .map_err(|e| e.to_string())?;
    let created_at: String = conn
        .query_row("SELECT created_at FROM workspace_snapshots WHERE id = ?1", [&id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    Ok(SnapshotMeta {
        id,
        workspace_id: workspace_id.to_string(),
        label: label.to_string(),
        item_count,
        link_count,
        created_at,
    })
}

// Re-apply a captured payload to the live tables. Caller runs this inside a
// transaction (execute_two_phase) so the whole rollback is atomic.
fn apply_snapshot(tx: &rusqlite::Transaction, ws: &str, payload: &SnapshotPayload) -> Result<(), String> {
    use std::collections::HashSet;
    let snap_ids: HashSet<&str> = payload.items.iter().map(|i| i.id.as_str()).collect();

    // 1. UPSERT every snapshot item, restoring its exact state incl. the deleted flag.
    for it in &payload.items {
        tx.execute(
            "INSERT INTO items \
                (id, workspace_id, item_type, title, created_at, user_pinned, user_size_preference, metadata, deleted) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
             ON CONFLICT(id) DO UPDATE SET \
                workspace_id=excluded.workspace_id, item_type=excluded.item_type, title=excluded.title, \
                created_at=excluded.created_at, user_pinned=excluded.user_pinned, \
                user_size_preference=excluded.user_size_preference, metadata=excluded.metadata, deleted=excluded.deleted",
            rusqlite::params![
                it.id, it.workspace_id, it.item_type, it.title, it.created_at,
                it.user_pinned, it.user_size_preference, it.metadata, it.deleted
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // 2. Soft-delete anything created in this workspace AFTER the snapshot (not in the
    //    captured id-set). Never hard-delete — keeps file rows/blobs intact.
    let mut live_stmt = tx
        .prepare("SELECT id FROM items WHERE workspace_id = ?1 AND deleted = 0")
        .map_err(|e| e.to_string())?;
    let live_ids: Vec<String> = live_stmt
        .query_map([ws], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(live_stmt);
    for id in &live_ids {
        if !snap_ids.contains(id.as_str()) {
            tx.execute("UPDATE items SET deleted = 1 WHERE id = ?1", [id])
                .map_err(|e| e.to_string())?;
        }
    }

    // 3. Rebuild links: drop every edge touching a workspace item, re-insert the
    //    snapshot's edges. INSERT OR IGNORE tolerates cross-workspace targets.
    tx.execute(
        "DELETE FROM links WHERE source_id IN (SELECT id FROM items WHERE workspace_id = ?1) \
            OR target_id IN (SELECT id FROM items WHERE workspace_id = ?1)",
        [ws],
    )
    .map_err(|e| e.to_string())?;
    for l in &payload.links {
        tx.execute(
            "INSERT OR IGNORE INTO links (source_id, target_id, relationship_type, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![l.source_id, l.target_id, l.relationship_type, l.created_at],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn create_workspace_snapshot(
    state: State<'_, AppState>,
    workspace_id: String,
    label: String,
) -> Result<SnapshotMeta, String> {
    state
        .db
        .call(move |conn| {
            let label = if label.trim().is_empty() { "Manual snapshot".to_string() } else { label };
            Ok(capture_snapshot(conn, &workspace_id, &label))
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|x| x)
}

#[tauri::command]
pub async fn get_workspace_snapshots(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<SnapshotMeta>, String> {
    state
        .db
        .call(move |conn| {
            let res = (|| -> Result<_, String> {
                let mut stmt = conn
                    .prepare(
                        "SELECT id, workspace_id, label, item_count, link_count, created_at \
                         FROM workspace_snapshots WHERE workspace_id = ?1 ORDER BY created_at DESC",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([&workspace_id], |r| {
                        Ok(SnapshotMeta {
                            id: r.get(0)?,
                            workspace_id: r.get(1)?,
                            label: r.get(2)?,
                            item_count: r.get(3)?,
                            link_count: r.get(4)?,
                            created_at: r.get(5)?,
                        })
                    })
                    .map_err(|e| e.to_string())?;
                let mut out = Vec::new();
                for r in rows {
                    out.push(r.map_err(|e| e.to_string())?);
                }
                Ok(out)
            })();
            Ok(res)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|x| x)
}

#[tauri::command]
pub async fn delete_workspace_snapshot(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .db
        .call(move |conn| {
            let res = conn
                .execute("DELETE FROM workspace_snapshots WHERE id = ?1", [&id])
                .map(|_| ())
                .map_err(|e| e.to_string());
            Ok(res)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|x| x)
}

#[tauri::command]
pub async fn restore_workspace_snapshot(
    state: State<'_, AppState>,
    id: String,
) -> Result<SnapshotMeta, String> {
    let ws = state
        .db
        .call(move |mut conn| {
            let res = (|| -> Result<_, String> {
                let (workspace_id, payload_s): (String, String) = conn
                    .query_row(
                        "SELECT workspace_id, payload FROM workspace_snapshots WHERE id = ?1",
                        [&id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(|_| format!("Snapshot '{}' not found", id))?;
                let payload: SnapshotPayload =
                    serde_json::from_str(&payload_s).map_err(|e| e.to_string())?;

                // Safety net: capture the current state before overwriting it, so a
                // rollback is itself undoable.
                capture_snapshot(&conn, &workspace_id, "Auto-backup before rollback")?;

                let ws2 = workspace_id.clone();
                let payload2 = payload.clone();
                let pay = format!(r#"{{"snapshot":"{}","workspace":"{}"}}"#, id, workspace_id);
                execute_two_phase(&mut conn, "restore_workspace_snapshot", &pay, |tx| {
                    apply_snapshot(tx, &ws2, &payload2)
                })?;
                Ok(workspace_id)
            })();
            Ok(res)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|x| x)?;

    // Tell every window to reconcile its cache against the rolled-back DB.
    let _ = tauri::Emitter::emit(&state.app_handle, crate::automation::DATA_CHANGED_EVENT, &ws);

    Ok(SnapshotMeta {
        id: String::new(),
        workspace_id: ws,
        label: "restored".into(),
        item_count: 0,
        link_count: 0,
        created_at: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::database::setup_schema(&c).unwrap();
        c.execute("INSERT INTO workspaces (id, name) VALUES ('ws','W')", []).unwrap();
        c
    }

    fn add(c: &Connection, id: &str, ty: &str, title: &str, deleted: i64) {
        c.execute(
            "INSERT INTO items (id, workspace_id, item_type, title, metadata, deleted) \
             VALUES (?1,'ws',?2,?3,'{}',?4)",
            rusqlite::params![id, ty, title, deleted],
        )
        .unwrap();
    }

    fn title_of(c: &Connection, id: &str) -> String {
        c.query_row("SELECT title FROM items WHERE id=?1", [id], |r| r.get(0)).unwrap()
    }
    fn is_deleted(c: &Connection, id: &str) -> bool {
        c.query_row("SELECT deleted FROM items WHERE id=?1", [id], |r| r.get::<_, i64>(0)).unwrap() == 1
    }

    #[test]
    fn deletion_history_lists_only_deleted() {
        let c = db();
        add(&c, "a", "note", "Alive", 0);
        add(&c, "b", "task", "Gone", 1);
        let h = deletion_history(&c, "ws").unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].id, "b");
        assert_eq!(h[0].title, "Gone");
    }

    #[test]
    fn snapshot_round_trip_restores_state() {
        let mut c = db();
        add(&c, "keep", "note", "Original", 0);
        add(&c, "victim", "task", "Will be deleted", 0);
        let snap = capture_snapshot(&c, "ws", "t0").unwrap();
        assert_eq!(snap.item_count, 2);

        // Mutate AFTER the snapshot: rename, delete one, add a new one.
        c.execute("UPDATE items SET title='Edited' WHERE id='keep'", []).unwrap();
        c.execute("UPDATE items SET deleted=1 WHERE id='victim'", []).unwrap();
        add(&c, "newbie", "note", "Created later", 0);

        // Restore.
        let (ws, payload_s): (String, String) = c
            .query_row("SELECT workspace_id, payload FROM workspace_snapshots WHERE id=?1", [&snap.id],
                |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        let payload: SnapshotPayload = serde_json::from_str(&payload_s).unwrap();
        let tx = c.transaction().unwrap();
        apply_snapshot(&tx, &ws, &payload).unwrap();
        tx.commit().unwrap();

        assert_eq!(title_of(&c, "keep"), "Original", "edit reverted");
        assert!(!is_deleted(&c, "victim"), "deletion reverted");
        assert!(is_deleted(&c, "newbie"), "item created after snapshot is soft-deleted");
    }

    #[test]
    fn snapshot_rebuilds_links() {
        let mut c = db();
        add(&c, "x", "note", "X", 0);
        add(&c, "y", "note", "Y", 0);
        c.execute("INSERT INTO links (source_id,target_id,relationship_type) VALUES ('x','y','related')", []).unwrap();
        let snap = capture_snapshot(&c, "ws", "withlink").unwrap();
        assert_eq!(snap.link_count, 1);

        // Drop the link, then restore the snapshot — it should come back.
        c.execute("DELETE FROM links", []).unwrap();
        let payload: SnapshotPayload = serde_json::from_str(
            &c.query_row("SELECT payload FROM workspace_snapshots WHERE id=?1", [&snap.id], |r| r.get::<_,String>(0)).unwrap()
        ).unwrap();
        let tx = c.transaction().unwrap();
        apply_snapshot(&tx, "ws", &payload).unwrap();
        tx.commit().unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM links", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "link restored from snapshot");
    }
}
