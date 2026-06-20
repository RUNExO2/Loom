use crate::AppState;
use crate::automation;
use serde::{Serialize, Deserialize};
use tauri::{Manager, State};

pub(crate) fn execute_two_phase<F, R>(conn: &mut rusqlite::Connection, cmd_type: &str, payload: &str, apply: F) -> Result<R, String>
where
    F: FnOnce(&rusqlite::Connection) -> Result<R, String>,
{
    let id = uuid::Uuid::new_v4().to_string();

    // Baseline integrity BEFORE the mutation. A write must only be blocked if IT
    // introduces a NEW violation — not because the DB already had pre-existing dirt
    // (e.g. an orphan link left by an old migration). Comparing before/after counts
    // means stale orphans no longer poison every subsequent create/update.
    let baseline = verify_integrity_all(conn)?;
    let baseline_orphans = baseline.orphan_links.len();
    let baseline_broken = baseline.broken_constraints.len();

    // Phase 1: Stage Intent
    conn.execute(
        "INSERT INTO mutation_ledger (id, command_type, payload, status) VALUES (?1, ?2, ?3, 'STAGED')",
        [&id, cmd_type, payload],
    ).map_err(|e| e.to_string())?;

    // Phase 2: Apply.
    // ponytail: SAVEPOINT, not BEGIN, so this is re-entrant. At the top level a
    // savepoint behaves like a transaction (commits on RELEASE); nested inside an
    // open savepoint (e.g. an automation run) it just nests instead of erroring
    // with "cannot start a transaction within a transaction".
    let tx = conn.savepoint().map_err(|e| e.to_string())?;
    let result = match apply(&tx) {
        Ok(r) => r,
        Err(e) => {
            drop(tx);
            let _ = conn.execute(
                "UPDATE mutation_ledger SET status = 'FAILED' WHERE id = ?1",
                [&id],
            );
            return Err(e);
        }
    };

    let integrity = verify_integrity_all(&tx)?;
    // Fail only if this mutation REGRESSED integrity (added orphans/broken constraints).
    if integrity.orphan_links.len() > baseline_orphans
        || integrity.broken_constraints.len() > baseline_broken
    {
        drop(tx);
        let _ = conn.execute(
            "UPDATE mutation_ledger SET status = 'FAILED' WHERE id = ?1",
            [&id],
        );
        return Err(format!("Integrity verification failed: {:?}", integrity));
    }
    
    tx.execute(
        "UPDATE mutation_ledger SET status = 'COMMITTED' WHERE id = ?1",
        [&id],
    ).map_err(|e| e.to_string())?;
    
    tx.commit().map_err(|e| e.to_string())?;
    
    Ok(result)
}

// Startup ledger reconciliation. A row stuck at STAGED means the process died after
// staging intent but before the transaction committed — SQLite already rolled the data
// back, so the truthful terminal state is FAILED. Then cap the ledger so this audit log
// can't grow without bound. Returns (reconciled, pruned) for the boot log.
pub(crate) fn sweep_stale_ledger(conn: &rusqlite::Connection) -> Result<(usize, usize), String> {
    let reconciled = conn
        .execute("UPDATE mutation_ledger SET status = 'FAILED' WHERE status = 'STAGED'", [])
        .map_err(|e| e.to_string())?;
    // ponytail: keep the last 1000 by created_at; raise the cap if forensics needs deeper history.
    let pruned = conn
        .execute(
            "DELETE FROM mutation_ledger WHERE id NOT IN \
             (SELECT id FROM mutation_ledger ORDER BY created_at DESC, rowid DESC LIMIT 1000)",
            [],
        )
        .map_err(|e| e.to_string())?;
    Ok((reconciled, pruned))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct IntegrityResult {
    pub ok: bool,
    pub orphan_links: Vec<String>,
    pub missing_refs: Vec<String>,
    pub broken_constraints: Vec<String>,
    pub repair_actions: Vec<String>,
}

pub(crate) fn verify_integrity_all(conn: &rusqlite::Connection) -> Result<IntegrityResult, String> {
    let mut orphan_links = Vec::new();
    let missing_refs = Vec::new();
    let mut broken_constraints = Vec::new();
    let mut repair_actions = Vec::new();

    // 1. Orphan links: source or target is soft-deleted or doesn't exist
    let mut stmt = conn.prepare(
        "SELECT l.source_id, l.target_id 
         FROM links l 
         LEFT JOIN items s ON l.source_id = s.id AND s.deleted = 0 
         LEFT JOIN items t ON l.target_id = t.id AND t.deleted = 0
         WHERE s.id IS NULL OR t.id IS NULL"
    ).map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map([], |row| {
        Ok(format!("{} -> {}", row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| e.to_string())?;
    
    for row in rows {
        let link = row.unwrap();
        orphan_links.push(link.clone());
        repair_actions.push(format!("Delete orphan link: {}", link));
    }

    // 2. Items with non-existent workspaces
    let mut stmt = conn.prepare(
        "SELECT i.id 
         FROM items i 
         LEFT JOIN workspaces w ON i.workspace_id = w.id 
         WHERE w.id IS NULL AND i.deleted = 0"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(row.get::<_, String>(0)?)
    }).map_err(|e| e.to_string())?;

    for row in rows {
        let item_id = row.unwrap();
        broken_constraints.push(format!("Item {} has missing workspace", item_id));
        repair_actions.push(format!("Soft-delete orphaned item: {}", item_id));
    }

    let ok = orphan_links.is_empty() && missing_refs.is_empty() && broken_constraints.is_empty();

    Ok(IntegrityResult {
        ok,
        orphan_links,
        missing_refs,
        broken_constraints,
        repair_actions,
    })
}

pub(crate) fn get_active_items(conn: &rusqlite::Connection, workspace_id: &str, limit: u32, offset: u32) -> Result<Vec<Item>, String> {
    let mut stmt = conn.prepare("SELECT id, workspace_id, item_type, title, created_at, user_pinned, user_size_preference, metadata FROM items WHERE workspace_id = ? AND deleted = 0 LIMIT ? OFFSET ?").map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map(rusqlite::params![workspace_id, limit, offset], |row| {
        Ok(Item {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            item_type: row.get(2)?,
            title: row.get(3)?,
            created_at: row.get(4)?,
            user_pinned: row.get(5)?,
            user_size_preference: row.get(6)?,
            metadata: row.get(7)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| e.to_string())?);
    }
    Ok(items)
}

pub(crate) fn get_links_safe(conn: &rusqlite::Connection, item_id: &str) -> Result<Vec<Link>, String> {
    let mut stmt = conn.prepare(
        "SELECT l.source_id, l.target_id, l.relationship_type, l.created_at \
         FROM links l \
         JOIN items s ON l.source_id = s.id \
         JOIN items t ON l.target_id = t.id \
         WHERE (l.source_id = ? OR l.target_id = ?) \
           AND s.deleted = 0 AND t.deleted = 0"
    ).map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map([item_id, item_id], |row| {
        Ok(Link {
            source_id: row.get(0)?,
            target_id: row.get(1)?,
            relationship_type: row.get(2)?,
            created_at: row.get(3)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut links = Vec::new();
    for row in rows {
        links.push(row.map_err(|e| e.to_string())?);
    }
    Ok(links)
}

// Phase 7: every live edge in a workspace in ONE query. Replaces the frontend's
// N+1 fan-out (one get_links per item) that made a full refresh cost N IPC round
// trips. Both endpoints are filtered to live items so the result is orphan-free.
pub(crate) fn get_all_links_safe(conn: &rusqlite::Connection, workspace_id: &str) -> Result<Vec<Link>, String> {
    let mut stmt = conn.prepare(
        "SELECT l.source_id, l.target_id, l.relationship_type, l.created_at \
         FROM links l \
         JOIN items s ON l.source_id = s.id \
         JOIN items t ON l.target_id = t.id \
         WHERE s.workspace_id = ?1 AND t.workspace_id = ?1 \
           AND s.deleted = 0 AND t.deleted = 0"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([workspace_id], |row| {
        Ok(Link {
            source_id: row.get(0)?,
            target_id: row.get(1)?,
            relationship_type: row.get(2)?,
            created_at: row.get(3)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut links = Vec::new();
    for row in rows {
        links.push(row.map_err(|e| e.to_string())?);
    }
    Ok(links)
}

// Returned by update/delete so callers never need to re-fetch the full list.
#[derive(Serialize, Deserialize, Debug)]
pub struct DeletedId {
    pub id: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Item {
    pub id: String,
    pub workspace_id: String,
    pub item_type: String,
    pub title: String,
    pub created_at: String,
    pub user_pinned: bool,
    pub user_size_preference: Option<String>,
    pub metadata: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Link {
    pub source_id: String,
    pub target_id: String,
    pub relationship_type: String,
    pub created_at: String,
}

#[tauri::command]
pub async fn create_workspace(state: State<'_, AppState>, name: String) -> Result<Workspace, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    
    let id = conn.query_row(
        "INSERT INTO workspaces (id, name) VALUES (lower(hex(randomblob(16))), ?) RETURNING id",
        [name.clone()],
        |row| row.get::<_, String>(0),
    ).map_err(|e| e.to_string())?;

    let created_at: String = conn.query_row(
        "SELECT created_at FROM workspaces WHERE id = ?",
        [id.clone()],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    Ok(Workspace { id, name, created_at })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn get_workspaces(state: State<'_, AppState>) -> Result<Vec<Workspace>, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    let mut stmt = conn.prepare("SELECT id, name, created_at FROM workspaces").map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map([], |row| {
        Ok(Workspace {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut workspaces = Vec::new();
    for row in rows {
        workspaces.push(row.map_err(|e| e.to_string())?);
    }
    Ok(workspaces)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

pub(crate) fn create_item_impl(conn: &rusqlite::Connection, workspace_id: String, title: String, item_type: String, metadata: String) -> Result<Item, String> {
    let id = conn.query_row(
        "INSERT INTO items (id, workspace_id, title, item_type, metadata) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?) RETURNING id",
        [workspace_id.clone(), title.clone(), item_type.clone(), metadata.clone()],
        |row| row.get::<_, String>(0),
    ).map_err(|e| e.to_string())?;

    let created_at: String = conn.query_row(
        "SELECT created_at FROM items WHERE id = ?",
        [id.clone()],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    Ok(Item {
        id,
        workspace_id,
        item_type,
        title,
        created_at,
        user_pinned: false,
        user_size_preference: None,
        metadata,
    })
}

#[tauri::command]
pub async fn create_item(state: State<'_, AppState>, workspace_id: String, title: String, item_type: String, metadata: String) -> Result<Item, String> {
    let item = {
        state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

        let payload = format!(r#"{{"workspace_id":"{}","title":"{}","item_type":"{}"}}"#, workspace_id, title, item_type);
        Ok(execute_two_phase(&mut conn, "create_item", &payload, |tx| {
            create_item_impl(tx, workspace_id, title, item_type, metadata)
        })?)
    
        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}?;
    automation::emit(&state, automation::events_for_created(&item));
    Ok(item)
}

#[tauri::command]
pub async fn get_items(state: State<'_, AppState>, workspace_id: String, limit: Option<u32>, offset: Option<u32>) -> Result<Vec<Item>, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    let l = limit.unwrap_or(1000000);
    let o = offset.unwrap_or(0);
    get_active_items(&conn, &workspace_id, l, o)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// ── Advanced search query parser ─────────────────────────────────────────────
// Turns free text into a safe FTS5 MATCH expression plus structured filters.
// Supported syntax (all optional, combine freely):
//   foo bar          implicit AND of prefix terms  ("foo"* "bar"*)
//   "exact phrase"   quoted phrase, matched verbatim (no prefix expansion)
//   foo OR bar       explicit OR
//   -foo  /  NOT foo exclude a term
//   type:task        restrict to item_type(s); comma-lists, e.g. type:task,note
//   #tag             treated as a normal term (tags are folded into FTS content)
// Every term is stripped to [alphanumeric_] before being quoted, so a user can
// never inject raw FTS5 operators (which would error the MATCH statement).
struct ParsedQuery {
    /// FTS5 MATCH expression. Empty = no full-text constraint.
    match_expr: String,
    /// item_type filters pulled out of `type:` tokens.
    types: Vec<String>,
}

fn sanitize_term(raw: &str) -> String {
    raw.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect()
}

// Split on whitespace but keep "quoted phrases" as one token. Returns (text, is_quoted).
fn tokenize_query(query: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for c in query.chars() {
        if c == '"' {
            if in_quote {
                out.push((std::mem::take(&mut cur), true));
                in_quote = false;
            } else {
                if !cur.is_empty() { out.push((std::mem::take(&mut cur), false)); }
                in_quote = true;
            }
        } else if c.is_whitespace() && !in_quote {
            if !cur.is_empty() { out.push((std::mem::take(&mut cur), false)); }
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() { out.push((cur, in_quote)); }
    out
}

fn parse_query(query: &str) -> ParsedQuery {
    let mut types: Vec<String> = Vec::new();
    let mut atoms: Vec<String> = Vec::new(); // positive atoms, may include "OR" separators
    let mut negs: Vec<String> = Vec::new();
    let mut pending_or = false;
    let mut pending_not = false;

    for (tok, quoted) in tokenize_query(query) {
        if !quoted {
            // Boolean keywords, only recognised as bare words.
            if tok.eq_ignore_ascii_case("or") { pending_or = true; continue; }
            if tok.eq_ignore_ascii_case("not") { pending_not = true; continue; }
            // Field filter: type:task,note
            let lower = tok.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("type:") {
                for t in rest.split(',') {
                    let t = sanitize_term(t);
                    if !t.is_empty() { types.push(t); }
                }
                continue;
            }
        }

        // Negation via leading '-' or a preceding bare NOT.
        let mut body = tok.clone();
        let mut is_neg = pending_not;
        pending_not = false;
        if !quoted {
            while body.starts_with('-') { is_neg = true; body.remove(0); }
        }

        let atom = if quoted {
            let words: Vec<String> = body
                .split_whitespace()
                .map(sanitize_term)
                .filter(|w| !w.is_empty())
                .collect();
            if words.is_empty() { pending_or = false; continue; }
            format!("\"{}\"", words.join(" "))
        } else {
            // leading '#' on tags is dropped by sanitize_term
            let cleaned = sanitize_term(&body);
            if cleaned.is_empty() { pending_or = false; continue; }
            format!("\"{}\"*", cleaned)
        };

        if is_neg {
            negs.push(atom);
            pending_or = false;
        } else {
            if pending_or && !atoms.is_empty() { atoms.push("OR".to_string()); }
            atoms.push(atom);
            pending_or = false;
        }
    }

    let mut match_expr = String::new();
    if !atoms.is_empty() {
        let pos = atoms.join(" ");
        match_expr = if negs.is_empty() { pos } else { format!("({})", pos) };
        for n in &negs {
            match_expr.push_str(" NOT ");
            match_expr.push_str(n);
        }
    }
    ParsedQuery { match_expr, types }
}

#[tauri::command]
pub async fn search_items(
    state: State<'_, AppState>,
    workspace_id: String,
    query: String,
    all_workspaces: Option<bool>,
) -> Result<Vec<Item>, String> {
    let all_ws = all_workspaces.unwrap_or(false);
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    // Advanced parse → FTS5 MATCH + structured filters. BM25 column weighting
    // favours title over body content, item_type lowest. A query that is only a
    // `type:` filter (no full-text) still works — it lists by recency.
    let parsed = parse_query(&query);
    let has_match = !parsed.match_expr.is_empty();
    if !has_match && parsed.types.is_empty() {
        return Ok(Vec::new());
    }

    let mut sql = String::from(
        "SELECT i.id, i.workspace_id, i.item_type, i.title, i.created_at, i.user_pinned, i.user_size_preference, i.metadata \
         FROM items i ",
    );
    let mut params: Vec<String> = Vec::new();
    let mut wheres: Vec<String> = vec!["i.deleted = 0".to_string()];

    if has_match {
        sql.push_str("JOIN items_fts ON items_fts.item_id = i.id ");
        wheres.push("items_fts MATCH ?".to_string());
        params.push(parsed.match_expr.clone());
    }
    if !all_ws {
        wheres.push("i.workspace_id = ?".to_string());
        params.push(workspace_id.clone());
    }
    if !parsed.types.is_empty() {
        let ph = parsed.types.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        wheres.push(format!("i.item_type IN ({})", ph));
        for t in &parsed.types { params.push(t.clone()); }
    }

    sql.push_str("WHERE ");
    sql.push_str(&wheres.join(" AND "));
    if has_match {
        // items_fts columns: item_id(UNINDEXED), title, item_type, content.
        sql.push_str(" ORDER BY bm25(items_fts, 0.0, 10.0, 2.0, 4.0)");
    } else {
        sql.push_str(" ORDER BY i.created_at DESC");
    }
    sql.push_str(" LIMIT 300");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        Ok(Item {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            item_type: row.get(2)?,
            title: row.get(3)?,
            created_at: row.get(4)?,
            user_pinned: row.get(5)?,
            user_size_preference: row.get(6)?,
            metadata: row.get(7)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| e.to_string())?);
    }
    Ok(items)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// ── Saved searches ────────────────────────────────────────────────────────────
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SavedSearch {
    pub id: String,
    pub name: String,
    pub query: String,
    pub scope: String, // "workspace" | "all"
    pub workspace_id: Option<String>,
    pub created_at: String,
}

#[tauri::command]
pub async fn create_saved_search(
    state: State<'_, AppState>,
    name: String,
    query: String,
    scope: String,
    workspace_id: Option<String>,
) -> Result<SavedSearch, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {
            let id = uuid::Uuid::new_v4().to_string();
            let scope = if scope == "all" { "all" } else { "workspace" }.to_string();
            // A cross-workspace ('all') search is not pinned to any workspace.
            let ws = if scope == "all" { None } else { workspace_id.clone() };
            conn.execute(
                "INSERT INTO saved_searches (id, name, query, scope, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, name, query, scope, ws],
            ).map_err(|e| e.to_string())?;
            let created_at: String = conn.query_row(
                "SELECT created_at FROM saved_searches WHERE id = ?1",
                [&id], |r| r.get(0),
            ).map_err(|e| e.to_string())?;
            Ok(SavedSearch { id, name, query, scope, workspace_id: ws, created_at })
        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn get_saved_searches(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<SavedSearch>, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {
            // This workspace's saved searches plus any cross-workspace ('all') ones.
            let mut stmt = conn.prepare(
                "SELECT id, name, query, scope, workspace_id, created_at FROM saved_searches \
                 WHERE scope = 'all' OR workspace_id = ?1 ORDER BY created_at DESC",
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([&workspace_id], |row| {
                Ok(SavedSearch {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    query: row.get(2)?,
                    scope: row.get(3)?,
                    workspace_id: row.get(4)?,
                    created_at: row.get(5)?,
                })
            }).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in rows { out.push(r.map_err(|e| e.to_string())?); }
            Ok(out)
        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn delete_saved_search(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {
            conn.execute("DELETE FROM saved_searches WHERE id = ?1", [&id]).map_err(|e| e.to_string())?;
            Ok(())
        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}


pub(crate) fn create_link_impl(conn: &rusqlite::Connection, source_id: String, target_id: String, relationship_type: String) -> Result<Link, String> {
    // Links may only connect two existing items in the SAME workspace. Blocks hidden
    // cross-workspace edges (a data-leak vector) and dangling links to missing items.
    let src_ws: Option<String> = conn.query_row("SELECT workspace_id FROM items WHERE id = ? AND deleted = 0", [&source_id], |r| r.get(0)).ok();
    let tgt_ws: Option<String> = conn.query_row("SELECT workspace_id FROM items WHERE id = ? AND deleted = 0", [&target_id], |r| r.get(0)).ok();
    match (src_ws, tgt_ws) {
        (Some(a), Some(b)) if a == b => {}
        _ => return Err("Refusing cross-workspace or dangling link".into()),
    }

    conn.execute(
        "INSERT OR IGNORE INTO links (source_id, target_id, relationship_type) VALUES (?, ?, ?)",
        [source_id.clone(), target_id.clone(), relationship_type.clone()],
    ).map_err(|e| e.to_string())?;

    let created_at: String = conn.query_row(
        "SELECT created_at FROM links WHERE source_id = ? AND target_id = ? AND relationship_type = ?",
        [source_id.clone(), target_id.clone(), relationship_type.clone()],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    Ok(Link { source_id, target_id, relationship_type, created_at })
}

#[tauri::command]
pub async fn create_link(state: State<'_, AppState>, source_id: String, target_id: String, relationship_type: String) -> Result<Link, String> {
    let source_id_clone = source_id.clone();
    let target_id_clone = target_id.clone();
    let relationship_type_clone = relationship_type.clone();
    let Ok((link, ws)) = ({
        state.db.call(move |mut conn| {
            let res = (|| -> Result<_, String> {
                let payload = format!(r#"{{"source_id":"{}","target_id":"{}","relationship_type":"{}"}}"#, source_id_clone, target_id_clone, relationship_type_clone);
                let ws: Option<String> = conn.query_row("SELECT workspace_id FROM items WHERE id = ?", [&source_id_clone], |r| r.get(0)).ok();
                let link = execute_two_phase(&mut conn, "create_link", &payload, |tx| {
                    create_link_impl(tx, source_id_clone.clone(), target_id_clone.clone(), relationship_type_clone.clone())
                })?;
                Ok((link, ws))
            })();
            Ok(res)
        }).await.map_err(|e| e.to_string()).and_then(|x| x)
    }) else { return Err("Failed to create link".to_string()) };

    if let Some(ws) = ws {
        automation::emit(&state, automation::events_for_link(&link.source_id, &link.target_id, &ws, true));
    }
    Ok(link)
}

#[tauri::command]
pub async fn delete_link(state: State<'_, AppState>, source_id: String, target_id: String, relationship_type: String) -> Result<DeletedId, String> {
    let source_id_clone = source_id.clone();
    let target_id_clone = target_id.clone();
    let relationship_type_clone = relationship_type.clone();
    let Ok((res_link, ws)) = ({
        state.db.call(move |mut conn| {
            let res = (|| -> Result<_, String> {
                let payload = format!(r#"{{"source_id":"{}","target_id":"{}","relationship_type":"{}"}}"#, source_id_clone, target_id_clone, relationship_type_clone);
                let ws: Option<String> = conn.query_row("SELECT workspace_id FROM items WHERE id = ?", [&source_id_clone], |r| r.get(0)).ok();
                let res = execute_two_phase(&mut conn, "delete_link", &payload, |tx| {
                    tx.execute(
                        "DELETE FROM links WHERE relationship_type = ?3 AND \
                         ((source_id = ?1 AND target_id = ?2) OR (source_id = ?2 AND target_id = ?1))",
                        [source_id_clone.clone(), target_id_clone.clone(), relationship_type_clone.clone()],
                    ).map_err(|e| e.to_string())?;

                    Ok(DeletedId { id: source_id_clone.clone() })
                })?;
                Ok((res, ws))
            })();
            Ok(res)
        }).await.map_err(|e| e.to_string()).and_then(|x| x)
    }) else { return Err("Failed to delete link".to_string()) };

    if let Some(ws) = ws {
        automation::emit(&state, automation::events_for_link(&source_id, &target_id, &ws, false));
    }
    Ok(res_link)
}

#[tauri::command]
pub async fn get_links(state: State<'_, AppState>, item_id: String) -> Result<Vec<Link>, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    get_links_safe(&conn, &item_id)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn get_all_links(state: State<'_, AppState>, workspace_id: String) -> Result<Vec<Link>, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    get_all_links_safe(&conn, &workspace_id)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// ── Workspace mutations ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn update_workspace(state: State<'_, AppState>, id: String, name: String) -> Result<Workspace, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let payload = format!(r#"{{"id":"{}","name":"{}"}}"#, id, name);
    
    execute_two_phase(&mut conn, "update_workspace", &payload, |tx| {
        let rows_changed = tx.execute(
            "UPDATE workspaces SET name = ? WHERE id = ?",
            [name.clone(), id.clone()],
        ).map_err(|e| e.to_string())?;

        if rows_changed == 0 {
            return Err(format!("Workspace '{}' not found", id));
        }

        let created_at: String = tx.query_row(
            "SELECT created_at FROM workspaces WHERE id = ?",
            [id.clone()],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;

        Ok(Workspace { id, name, created_at })
    })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn delete_workspace(state: State<'_, AppState>, id: String, app_handle: tauri::AppHandle) -> Result<DeletedId, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {


    let mut stmt = conn.prepare(
        "SELECT f.id, f.path FROM files f JOIN items i ON f.id = i.id WHERE i.workspace_id = ?"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([&id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
    let mut files_to_stage = Vec::new();
    for r in rows {
        if let Ok((fid, path)) = r {
            files_to_stage.push((fid, path));
        }
    }
    drop(stmt);

    let app_data_dir = app_handle.path().app_data_dir().unwrap_or_default();
    let files_dir = app_data_dir.join("Files");
    let notes_dir = app_data_dir.join("Notes");

    // 1. Prepare Phase (Filesystem staging to trash)
    let mut staged_files = Vec::new();
    for (fid, path) in &files_to_stage {
        let p = std::path::Path::new(path);
        if p.starts_with(&files_dir) || p.starts_with(&notes_dir) {
            if let Ok(_) = crate::fs_commands::move_file_to_trash(&app_handle, fid, path) {
                staged_files.push((fid.clone(), path.clone()));
                let filename = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO trash_ledger (id, original_path, filename) VALUES (?1, ?2, ?3)",
                    [fid, path, &filename],
                );
            }
        }
    }

    // 2. Commit Phase (Database)
    let payload = format!(r#"{{"id":"{}"}}"#, id);
    let res = execute_two_phase(&mut conn, "delete_workspace", &payload, |tx| {
        let rows_changed = tx.execute(
            "DELETE FROM workspaces WHERE id = ?",
            [id.clone()],
        ).map_err(|e| e.to_string())?;

        if rows_changed == 0 {
            return Err(format!("Workspace '{}' not found", id));
        }

        Ok(DeletedId { id: id.clone() })
    });

    // 3. Compensation / Rollback
    match res {
        Ok(val) => Ok(val),
        Err(e) => {
            for (fid, path) in staged_files {
                let _ = crate::fs_commands::restore_file_from_trash(&app_handle, &fid, &path);
                let _ = conn.execute("DELETE FROM trash_ledger WHERE id = ?", [&fid]);
            }
            Err(e)
        }
    }

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// ── Item mutations ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn update_item(state: State<'_, AppState>, id: String, title: String, item_type: String) -> Result<Item, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let payload = format!(r#"{{"id":"{}","title":"{}","item_type":"{}"}}"#, id, title, item_type);
    
    execute_two_phase(&mut conn, "update_item", &payload, |tx| {
        let rows_changed = tx.execute(
            "UPDATE items SET title = ?, item_type = ? WHERE id = ?",
            [title.clone(), item_type.clone(), id.clone()],
        ).map_err(|e| e.to_string())?;

        if rows_changed == 0 {
            return Err(format!("Item '{}' not found", id));
        }

        let mut stmt = tx.prepare("SELECT workspace_id, created_at, user_pinned, user_size_preference, metadata FROM items WHERE id = ?").map_err(|e| e.to_string())?;
        let item = stmt.query_row([id.clone()], |row| {
            Ok(Item {
                id: id.clone(),
                workspace_id: row.get(0)?,
                item_type: item_type.clone(),
                title: title.clone(),
                created_at: row.get(1)?,
                user_pinned: row.get(2)?,
                user_size_preference: row.get(3)?,
                metadata: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;

        Ok(item)
    })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn update_item_intent(state: State<'_, AppState>, id: String, user_pinned: bool, user_size_preference: Option<String>) -> Result<Item, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let payload = format!(r#"{{"id":"{}","user_pinned":{},"user_size_preference":{:?}}}"#, id, user_pinned, user_size_preference);
    
    execute_two_phase(&mut conn, "update_item_intent", &payload, |tx| {
        let rows_changed = tx.execute(
            "UPDATE items SET user_pinned = ?, user_size_preference = ? WHERE id = ?",
            rusqlite::params![user_pinned, user_size_preference, id.clone()],
        ).map_err(|e| e.to_string())?;

        if rows_changed == 0 {
            return Err(format!("Item '{}' not found", id));
        }

        let mut stmt = tx.prepare("SELECT workspace_id, item_type, title, created_at, metadata FROM items WHERE id = ?").map_err(|e| e.to_string())?;
        let item = stmt.query_row([id.clone()], |row| {
            Ok(Item {
                id: id.clone(),
                workspace_id: row.get(0)?,
                item_type: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
                user_pinned,
                user_size_preference: user_size_preference.clone(),
                metadata: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;

        Ok(item)
    })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn update_item_metadata(state: State<'_, AppState>, id: String, metadata: String) -> Result<Item, String> {
    let item = {
        state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

        let payload = format!(r#"{{"id":"{}","metadata":"{}"}}"#, id, metadata.replace('"', "\\\""));

        execute_two_phase(&mut conn, "update_item_metadata", &payload, |tx| {
            let rows_changed = tx.execute(
                "UPDATE items SET metadata = ? WHERE id = ?",
                [metadata.clone(), id.clone()],
            ).map_err(|e| e.to_string())?;

            if rows_changed == 0 {
                return Err(format!("Item '{}' not found", id));
            }

            let mut stmt = tx.prepare("SELECT workspace_id, item_type, title, created_at, user_pinned, user_size_preference FROM items WHERE id = ?").map_err(|e| e.to_string())?;
            let item = stmt.query_row([id.clone()], |row| {
                Ok(Item {
                    id: id.clone(),
                    workspace_id: row.get(0)?,
                    item_type: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    user_pinned: row.get(4)?,
                    user_size_preference: row.get(5)?,
                    metadata: metadata.clone(),
                })
            }).map_err(|e| e.to_string())?;

            Ok(item)
        })
    
        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}?;
    // Don't let automation events fire for the engine's own metadata writes — those
    // go through create_item_impl/raw UPDATEs, never this command. Automations of
    // item_type 'automation' (toggling on/off) also shouldn't self-trigger.
    if item.item_type != "automation" {
        automation::emit(&state, automation::events_for_updated(&item));
    }
    Ok(item)
}

#[allow(dead_code)] // only called from the #[cfg(test)] suite; unused in non-test builds
pub(crate) fn delete_item_impl(conn: &rusqlite::Connection, id: String) -> Result<DeletedId, String> {
    let rows_changed = conn.execute("UPDATE items SET deleted = 1 WHERE id = ? AND deleted = 0", [id.clone()]).map_err(|e| e.to_string())?;
    if rows_changed == 0 {
        return Err(format!("Item '{}' not found or already deleted", id));
    }
    Ok(DeletedId { id })
}

#[tauri::command]
pub async fn delete_item(state: State<'_, AppState>, id: String, app_handle: tauri::AppHandle) -> Result<DeletedId, String> {
    let id_clone = id.clone();
    let db_res = state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {
            let file_info: Option<(String, String)> = conn.query_row(
                "SELECT i.item_type, f.path FROM items i JOIN files f ON i.id = f.id WHERE i.id = ?",
                [&id_clone],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            ).ok();

            let type_ws: Option<(String, String)> = conn.query_row(
                "SELECT item_type, workspace_id FROM items WHERE id = ?",
                [&id_clone],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            ).ok();

            // 1. Prepare Phase
            let mut staged_file = false;
            let mut original_path = String::new();
            if let Some((item_type, path)) = &file_info {
                if item_type == "file" || item_type == "note" {
                    let app_data_dir = app_handle.path().app_data_dir().unwrap_or_default();
                    let files_dir = app_data_dir.join("Files");
                    let notes_dir = app_data_dir.join("Notes");
                    let p = std::path::Path::new(path);
                    if p.starts_with(files_dir) || p.starts_with(notes_dir) {
                        crate::fs_commands::move_file_to_trash(&app_handle, &id_clone, path)?;
                        staged_file = true;
                        original_path = path.clone();
                        let filename = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                        conn.execute(
                            "INSERT OR REPLACE INTO trash_ledger (id, original_path, filename) VALUES (?1, ?2, ?3)",
                            [&id_clone, path, &filename],
                        ).map_err(|e| format!("Failed to update staging ledger: {}", e))?;
                    }
                }
            }

            // 2. Commit Phase
            let payload = format!(r#"{{"id":"{}"}}"#, id_clone);
            let res_inner = execute_two_phase(&mut conn, "delete_item", &payload, |tx| {
                let rows_changed = tx.execute(
                    "UPDATE items SET deleted = 1 WHERE id = ? AND deleted = 0",
                    [id_clone.clone()],
                ).map_err(|e| e.to_string())?;

                if rows_changed == 0 {
                    return Err(format!("Item '{}' not found or already deleted", id_clone));
                }

                // Drop edges touching this item in the SAME tx. Otherwise they become
                // orphan links (endpoint now deleted=0-filtered), which the two-phase
                // integrity check counts as a NEW regression and rejects the delete —
                // i.e. any linked item would be undeletable. Undo re-inserts them from
                // the snapshot via restore_snapshot_impl.
                tx.execute(
                    "DELETE FROM links WHERE source_id = ?1 OR target_id = ?1",
                    [id_clone.clone()],
                ).map_err(|e| e.to_string())?;

                Ok(DeletedId { id: id_clone.clone() })
            });

            match res_inner {
                Ok(val) => Ok((val, type_ws)),
                Err(e) => {
                    if staged_file {
                        let _ = crate::fs_commands::restore_file_from_trash(&app_handle, &id_clone, &original_path);
                        let _ = conn.execute("DELETE FROM trash_ledger WHERE id = ?", [&id_clone]);
                    }
                    Err(e)
                }
            }
        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)?;

    let (val, type_ws) = db_res;
    if let Some((item_type, ws)) = type_ws {
        if item_type != "automation" {
            automation::emit(&state, automation::events_for_deleted(&id, &item_type, &ws));
        }
    }
    Ok(val)
}

pub(crate) fn restore_snapshot_impl(conn: &rusqlite::Connection, item: Item, links: Vec<Link>) -> Result<Item, String> {
    let rows_changed = conn.execute(
        "UPDATE items SET workspace_id=?2, item_type=?3, title=?4, created_at=?5, user_pinned=?6, user_size_preference=?7, metadata=?8, deleted=0 WHERE id=?1",
        rusqlite::params![
            item.id, item.workspace_id, item.item_type, item.title,
            item.created_at, item.user_pinned, item.user_size_preference, item.metadata
        ],
    ).map_err(|e| format!("Failed to restore item: {}", e))?;

    if rows_changed == 0 {
        return Err(format!("Item '{}' not found. Immutable IDs require UPDATE, not INSERT.", item.id));
    }

    for link in &links {
        conn.execute(
            "INSERT OR IGNORE INTO links (source_id, target_id, relationship_type, created_at) 
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![link.source_id, link.target_id, link.relationship_type, link.created_at],
        ).map_err(|e| format!("Failed to restore link: {}", e))?;
    }

    Ok(item)
}

#[tauri::command]
pub async fn restore_snapshot(state: State<'_, AppState>, app_handle: tauri::AppHandle, item: Item, links: Vec<Link>) -> Result<Item, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    
    // Get path from trash_ledger or files table
    let original_path: Option<String> = conn.query_row(
        "SELECT original_path FROM trash_ledger WHERE id = ?1 UNION SELECT path FROM files WHERE id = ?1 LIMIT 1",
        [&item.id],
        |r| r.get(0)
    ).ok();

    // 1. Prepare Phase (Filesystem)
    let mut staged_restore = false;
    if let Some(ref path) = original_path {
        crate::fs_commands::restore_file_from_trash(&app_handle, &item.id, path)?;
        staged_restore = true;
    }

    // 2. Commit Phase (Database)
    let payload = format!(r#"{{"id":"{}"}}"#, item.id);
    let res = execute_two_phase(&mut conn, "restore_snapshot", &payload, |tx| {
        let restored = restore_snapshot_impl(tx, item.clone(), links.clone())?;
        tx.execute("DELETE FROM trash_ledger WHERE id = ?", [&item.id]).map_err(|e| e.to_string())?;
        Ok(restored)
    });

    // 3. Compensation / Rollback
    match res {
        Ok(val) => Ok(val),
        Err(e) => {
            if staged_restore {
                if let Some(ref path) = original_path {
                    let _ = crate::fs_commands::move_file_to_trash(&app_handle, &item.id, path);
                }
            }
            Err(e)
        }
    }

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

pub(crate) fn verify_integrity_impl(conn: &rusqlite::Connection, id: String, expected_existence: bool) -> Result<bool, String> {
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM items WHERE id = ? AND deleted = 0",
        [id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    Ok((count > 0) == expected_existence)
}

#[tauri::command]
pub async fn verify_integrity(state: State<'_, AppState>, id: String, expected_existence: bool) -> Result<bool, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    verify_integrity_impl(&conn, id, expected_existence)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[derive(Serialize)]
pub struct SystemStateDump {
    pub items: Vec<String>,
    pub links: Vec<String>,
}

#[tauri::command]
pub async fn get_system_state(state: State<'_, AppState>, workspace_id: String) -> Result<SystemStateDump, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {


    let mut item_stmt = conn.prepare("SELECT id, item_type, title FROM items WHERE deleted = 0 AND workspace_id = ? ORDER BY id ASC").map_err(|e| e.to_string())?;
    let items_iter = item_stmt.query_map([&workspace_id], |row| {
        Ok(format!("{}:{}:{}", row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    }).map_err(|e| e.to_string())?;

    let mut link_stmt = conn.prepare(
        "SELECT l.source_id, l.target_id, l.relationship_type \
         FROM links l \
         JOIN items s ON l.source_id = s.id \
         JOIN items t ON l.target_id = t.id \
         WHERE s.deleted = 0 AND t.deleted = 0 \
           AND (s.workspace_id = ? OR t.workspace_id = ?) \
         ORDER BY l.source_id ASC, l.target_id ASC, l.relationship_type ASC"
    ).map_err(|e| e.to_string())?;
    let links_iter = link_stmt.query_map([&workspace_id, &workspace_id], |row| {
        Ok(format!("{}:{}:{}", row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    }).map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for item in items_iter {
        items.push(item.map_err(|e| e.to_string())?);
    }
    
    let mut links = Vec::new();
    for link in links_iter {
        links.push(link.map_err(|e| e.to_string())?);
    }

    Ok(SystemStateDump { items, links })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// ── Settings ──────────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?").map_err(|e| e.to_string())?;
    
    let mut rows = stmt.query([key]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let value: String = row.get(0).map_err(|e| e.to_string())?;
        Ok(Some(value))
    } else {
        Ok(None)
    }

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = CURRENT_TIMESTAMP",
        [&key, &value],
    ).map_err(|e| e.to_string())?;
    Ok(())

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct LedgerEntry {
    pub id: String,
    pub command_type: String,
    pub payload: String,
    pub status: String,
    pub created_at: String,
}

#[tauri::command]
pub async fn get_mutation_ledger(state: State<'_, AppState>) -> Result<Vec<LedgerEntry>, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    let mut stmt = conn.prepare("SELECT id, command_type, payload, status, created_at FROM mutation_ledger ORDER BY created_at DESC LIMIT 100").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(LedgerEntry {
            id: row.get(0)?,
            command_type: row.get(1)?,
            payload: row.get(2)?,
            status: row.get(3)?,
            created_at: row.get(4)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| e.to_string())?);
    }
    Ok(entries)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[derive(Serialize)]
pub struct SystemHealth {
    pub sqlite_file_size_bytes: u64,
    pub active_items: usize,
    pub active_links: usize,
    pub soft_deleted_items: usize,
    pub orphaned_links: usize,
    pub last_integrity_check: String,
}

#[tauri::command]
pub async fn get_system_health(state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<SystemHealth, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    
    let active_items: usize = conn.query_row("SELECT count(*) FROM items WHERE deleted = 0", [], |row| row.get(0)).unwrap_or(0);
    let active_links: usize = conn.query_row("SELECT count(*) FROM links", [], |row| row.get(0)).unwrap_or(0);
    let soft_deleted_items: usize = conn.query_row("SELECT count(*) FROM items WHERE deleted = 1", [], |row| row.get(0)).unwrap_or(0);
    
    // orphan count
    let integrity = verify_integrity_all(&conn)?;
    let orphaned_links = integrity.orphan_links.len();
    
    // file size
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data_dir.join("loom.db");
    let file_size = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);

    Ok(SystemHealth {
        sqlite_file_size_bytes: file_size,
        active_items,
        active_links,
        soft_deleted_items,
        orphaned_links,
        last_integrity_check: chrono::Local::now().to_rfc3339(),
    })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn repair_integrity(state: State<'_, AppState>) -> Result<IntegrityResult, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let payload = r#"{}"#;
    execute_two_phase(&mut conn, "repair_integrity", payload, |tx| {
        // 1. Delete orphan links
        tx.execute(
            "DELETE FROM links 
             WHERE source_id IN (SELECT id FROM items WHERE deleted = 1) 
                OR target_id IN (SELECT id FROM items WHERE deleted = 1)
                OR source_id NOT IN (SELECT id FROM items)
                OR target_id NOT IN (SELECT id FROM items)", 
            []
        ).map_err(|e| e.to_string())?;

        // 2. Soft delete items with no workspace
        tx.execute(
            "UPDATE items SET deleted = 1 
             WHERE workspace_id NOT IN (SELECT id FROM workspaces)",
            []
        ).map_err(|e| e.to_string())?;

        Ok(())
    })?;

    let integrity = verify_integrity_all(&conn)?;
    Ok(integrity)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_plain_terms_are_and_prefixed() {
        let p = parse_query("foo bar");
        assert_eq!(p.match_expr, "\"foo\"* \"bar\"*");
        assert!(p.types.is_empty());
    }

    #[test]
    fn parse_type_filter_is_extracted() {
        let p = parse_query("type:task,note urgent");
        assert_eq!(p.types, vec!["task", "note"]);
        assert_eq!(p.match_expr, "\"urgent\"*");
    }

    #[test]
    fn parse_phrase_or_and_negation() {
        let p = parse_query("\"design system\" OR theme -draft");
        assert_eq!(p.match_expr, "(\"design system\" OR \"theme\"*) NOT \"draft\"*");
    }

    #[test]
    fn parse_strips_fts_operators_safely() {
        // Raw FTS operators in a bare term must be neutralised, not passed through.
        let p = parse_query("foo(bar)*");
        assert_eq!(p.match_expr, "\"foobar\"*");
    }

    #[test]
    fn parse_type_only_has_no_match_expr() {
        let p = parse_query("type:project");
        assert!(p.match_expr.is_empty());
        assert_eq!(p.types, vec!["project"]);
    }

    #[test]
    fn parse_empty_is_empty() {
        let p = parse_query("   ");
        assert!(p.match_expr.is_empty());
        assert!(p.types.is_empty());
    }

    #[test]
    fn test_db_queries() -> Result<(), Box<dyn std::error::Error>> {
        let appdata = match std::env::var("APPDATA") {
            Ok(val) => val,
            Err(_) => {
                println!("APPDATA environment variable not set, skipping test.");
                return Ok(());
            }
        };
        let db_path = std::path::Path::new(&appdata).join("com.rune.loom").join("loom.db");
        if !db_path.exists() {
            println!("Database file not found at {:?}, skipping test.", db_path);
            return Ok(());
        }
        
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        
        // Ensure schema is up to date (so migration runs and adds deleted column)
        crate::database::setup_schema(&conn).unwrap();
        
        // 1. Get workspaces
        let mut ws_stmt = conn.prepare("SELECT id, name, created_at FROM workspaces").unwrap();
        let ws_rows = ws_stmt.query_map([], |row| {
            Ok(Workspace {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
            })
        }).unwrap();
        
        let mut workspaces = Vec::new();
        for r in ws_rows {
            workspaces.push(r.unwrap());
        }
        println!("Loaded workspaces: {:?}", workspaces);

        if workspaces.is_empty() {
            println!("No workspaces found in DB.");
            return Ok(());
        }

        // 2. Get items of the first workspace
        let target_ws_id = workspaces[0].id.clone();
        println!("Querying items for workspace ID: {}", target_ws_id);
        
        let mut stmt = conn.prepare("SELECT id, workspace_id, item_type, title, created_at, user_pinned, user_size_preference, metadata FROM items WHERE workspace_id = ? AND deleted = 0").unwrap();
        let rows = stmt.query_map([target_ws_id], |row| {
            Ok(Item {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                item_type: row.get(2)?,
                title: row.get(3)?,
                created_at: row.get(4)?,
                user_pinned: row.get(5)?,
                user_size_preference: row.get(6)?,
                metadata: row.get(7)?,
            })
        }).unwrap();
        
        let mut items = Vec::new();
        for r in rows {
            match r {
                Ok(item) => {
                    println!("Loaded Item: {} (type: {})", item.title, item.item_type);
                    items.push(item);
                }
                Err(e) => {
                    println!("Failed mapping item: {:?}", e);
                    panic!("Mapping failed");
                }
            }
        }
        println!("Successfully loaded {} items", items.len());
        // The existing test_db_queries ... (keep as is)
        Ok(())
    }

    fn setup_test_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::database::setup_schema(&conn).unwrap();
        // Insert a dummy workspace
        conn.execute(
            "INSERT INTO workspaces (id, name) VALUES ('ws-1', 'Test Workspace')",
            [],
        ).unwrap();
        conn
    }

    #[test]
    fn test_create_and_delete_item() {
        let conn = setup_test_db();
        
        // Test Create
        let item = create_item_impl(&conn, "ws-1".into(), "My Title".into(), "task".into(), "{}".into()).unwrap();
        assert_eq!(item.title, "My Title");
        assert_eq!(item.workspace_id, "ws-1");

        // Verify Integrity (Item should exist)
        let exists = verify_integrity_impl(&conn, item.id.clone(), true).unwrap();
        assert!(exists);

        // Test Delete
        let deleted = delete_item_impl(&conn, item.id.clone()).unwrap();
        assert_eq!(deleted.id, item.id);

        // Verify Integrity (Item should NOT exist)
        let exists_after = verify_integrity_impl(&conn, item.id.clone(), false).unwrap();
        assert!(exists_after);
        
        // Deleting again should error
        let err = delete_item_impl(&conn, item.id.clone());
        assert!(err.is_err());
    }

    #[test]
    fn test_link_and_unlink_integrity() {
        let conn = setup_test_db();
        
        let item1 = create_item_impl(&conn, "ws-1".into(), "A".into(), "note".into(), "{}".into()).unwrap();
        let item2 = create_item_impl(&conn, "ws-1".into(), "B".into(), "note".into(), "{}".into()).unwrap();

        // Create Link
        let link = create_link_impl(&conn, item1.id.clone(), item2.id.clone(), "related".into()).unwrap();
        assert_eq!(link.source_id, item1.id);
        assert_eq!(link.target_id, item2.id);

        // Verify in DB directly
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM links", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);

        // Delete one of the items (soft delete) should NOT cascade delete the link
        delete_item_impl(&conn, item1.id.clone()).unwrap();
        let count_after: i64 = conn.query_row("SELECT COUNT(*) FROM links", [], |row| row.get(0)).unwrap();
        assert_eq!(count_after, 1);
    }

    #[test]
    fn test_link_rejects_cross_workspace_and_dangling() {
        let conn = setup_test_db();
        conn.execute("INSERT INTO workspaces (id, name) VALUES ('ws-2','Other')", []).unwrap();
        let a = create_item_impl(&conn, "ws-1".into(), "A".into(), "note".into(), "{}".into()).unwrap();
        let b = create_item_impl(&conn, "ws-2".into(), "B".into(), "note".into(), "{}".into()).unwrap();
        // cross-workspace link is refused
        assert!(create_link_impl(&conn, a.id.clone(), b.id.clone(), "related".into()).is_err());
        // dangling target is refused
        assert!(create_link_impl(&conn, a.id.clone(), "nope".into(), "related".into()).is_err());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM links", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn test_restore_snapshot_transaction() {
        let mut conn = setup_test_db();
        
        let item1 = create_item_impl(&conn, "ws-1".into(), "A".into(), "note".into(), "{}".into()).unwrap();
        let item2 = create_item_impl(&conn, "ws-1".into(), "B".into(), "note".into(), "{}".into()).unwrap();
        let link = create_link_impl(&conn, item1.id.clone(), item2.id.clone(), "related".into()).unwrap();

        // Simulate snapshotting
        let snapshot_item = item1;
        let snapshot_links = vec![link];

        // Delete the item (soft delete)
        delete_item_impl(&conn, snapshot_item.id.clone()).unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE id = ? AND deleted = 0", [&snapshot_item.id], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);

        // Restore snapshot
        restore_snapshot_impl(&mut conn, snapshot_item.clone(), snapshot_links.clone()).unwrap();

        // Verify restoration
        let count_items: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE id = ? AND deleted = 0", [&snapshot_item.id], |r| r.get(0)).unwrap();
        assert_eq!(count_items, 1);
        let count_links: i64 = conn.query_row("SELECT COUNT(*) FROM links", [], |r| r.get(0)).unwrap();
        assert_eq!(count_links, 1);
    }

    // Mirrors the production graph/relationship query: an edge is only "live" when
    // BOTH endpoints are un-deleted (commands.rs:82-83, 764). Soft-deleting either
    // endpoint hides the edge; restoring un-hides it — without touching the row.
    fn live_edge(conn: &rusqlite::Connection, a: &str, b: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM links l \
             JOIN items s ON l.source_id = s.id AND s.deleted = 0 \
             JOIN items t ON l.target_id = t.id AND t.deleted = 0 \
             WHERE (l.source_id = ?1 AND l.target_id = ?2) OR (l.source_id = ?2 AND l.target_id = ?1)",
            rusqlite::params![a, b],
            |r| r.get(0),
        ).unwrap()
    }

    // ── UUID preservation: delete → undo restores the SAME identity ───────────
    #[test]
    fn delete_undo_preserves_uuid() {
        let conn = setup_test_db();
        let item = create_item_impl(&conn, "ws-1".into(), "Keep".into(), "task".into(), r#"{"k":1}"#.into()).unwrap();
        let original_id = item.id.clone();

        delete_item_impl(&conn, item.id.clone()).unwrap();
        // Undo = restore the captured snapshot.
        let restored = restore_snapshot_impl(&conn, item.clone(), vec![]).unwrap();

        assert_eq!(restored.id, original_id, "restore MUST reuse the original UUID");
        let live_id: String = conn.query_row(
            "SELECT id FROM items WHERE id = ? AND deleted = 0", [&original_id], |r| r.get(0)).unwrap();
        assert_eq!(live_id, original_id, "exactly the original row is live again");
        // Metadata/title/type round-trip intact.
        let (title, meta): (String, String) = conn.query_row(
            "SELECT title, metadata FROM items WHERE id = ?", [&original_id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((title.as_str(), meta.as_str()), ("Keep", r#"{"k":1}"#));
    }

    // ── delete → undo → redo: identity stable across the full cycle ───────────
    #[test]
    fn delete_redo_cycle_keeps_identity() {
        let conn = setup_test_db();
        let item = create_item_impl(&conn, "ws-1".into(), "Cycle".into(), "note".into(), "{}".into()).unwrap();
        let id = item.id.clone();

        // delete
        delete_item_impl(&conn, id.clone()).unwrap();
        // undo (restore)
        restore_snapshot_impl(&conn, item.clone(), vec![]).unwrap();
        assert!(verify_integrity_impl(&conn, id.clone(), true).unwrap());
        // redo (delete again) — must succeed on the same row, not a new one
        delete_item_impl(&conn, id.clone()).unwrap();
        assert!(verify_integrity_impl(&conn, id.clone(), false).unwrap());
        // undo again
        restore_snapshot_impl(&conn, item.clone(), vec![]).unwrap();

        // Throughout, only ONE physical row ever existed for this id.
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE id = ?", [&id], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "no duplicate row minted across delete/undo/redo");
    }

    // ── The core guarantee: restore can NEVER mint a new UUID ─────────────────
    #[test]
    fn restore_cannot_mint_new_uuid() {
        let conn = setup_test_db();
        // An item that was never persisted (simulates a purged / unknown id).
        let ghost = Item {
            id: "ghost-id-0000".into(),
            workspace_id: "ws-1".into(),
            item_type: "task".into(),
            title: "Ghost".into(),
            created_at: "2026-01-01T00:00:00+00:00".into(),
            user_pinned: false,
            user_size_preference: None,
            metadata: "{}".into(),
        };
        let res = restore_snapshot_impl(&conn, ghost, vec![]);
        assert!(res.is_err(), "restoring a non-existent row must fail, not INSERT a new identity");
        assert!(res.unwrap_err().contains("Immutable IDs require UPDATE"), "fails for the right reason");
        // And nothing was created.
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE id = 'ghost-id-0000'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "no row may exist for a would-be-minted id");
    }

    // ── Bulk delete / restore: every UUID preserved, count exact ──────────────
    #[test]
    fn bulk_delete_restore_preserves_all_uuids() {
        let conn = setup_test_db();
        let items: Vec<Item> = (0..5)
            .map(|i| create_item_impl(&conn, "ws-1".into(), format!("B{}", i), "task".into(), "{}".into()).unwrap())
            .collect();
        let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();

        for it in &items { delete_item_impl(&conn, it.id.clone()).unwrap(); }
        let live_after_delete: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE deleted = 0", [], |r| r.get(0)).unwrap();
        assert_eq!(live_after_delete, 0, "all 5 soft-deleted");

        for it in &items { restore_snapshot_impl(&conn, it.clone(), vec![]).unwrap(); }
        // Same five ids live again — no more, no fewer, none renamed.
        for id in &ids {
            assert!(verify_integrity_impl(&conn, id.clone(), true).unwrap(), "id {} restored", id);
        }
        let total_rows: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(total_rows, 5, "bulk restore minted no extra rows");
    }

    // ── Backlink restoration: restoring the TARGET re-lives the inbound edge ───
    #[test]
    fn backlink_restoration() {
        let conn = setup_test_db();
        let a = create_item_impl(&conn, "ws-1".into(), "A".into(), "note".into(), "{}".into()).unwrap();
        let b = create_item_impl(&conn, "ws-1".into(), "B".into(), "note".into(), "{}".into()).unwrap();
        // A → B : B holds the backlink.
        let link = create_link_impl(&conn, a.id.clone(), b.id.clone(), "related".into()).unwrap();
        assert_eq!(live_edge(&conn, &a.id, &b.id), 1, "edge live before delete");

        // Delete the TARGET. Edge goes dark but the row survives.
        delete_item_impl(&conn, b.id.clone()).unwrap();
        assert_eq!(live_edge(&conn, &a.id, &b.id), 0, "backlink hidden while target deleted");

        // Restore B with its link snapshot → inbound backlink reappears, same created_at.
        restore_snapshot_impl(&conn, b.clone(), vec![link.clone()]).unwrap();
        assert_eq!(live_edge(&conn, &a.id, &b.id), 1, "backlink restored");
        let ts: String = conn.query_row(
            "SELECT created_at FROM links WHERE source_id = ? AND target_id = ?",
            rusqlite::params![a.id, b.id], |r| r.get(0)).unwrap();
        assert_eq!(ts, link.created_at, "link created_at preserved, not regenerated");
    }

    // ── Graph restoration: delete a hub node, restore rebuilds both edges ──────
    #[test]
    fn graph_restoration_multinode() {
        let conn = setup_test_db();
        let a = create_item_impl(&conn, "ws-1".into(), "A".into(), "note".into(), "{}".into()).unwrap();
        let b = create_item_impl(&conn, "ws-1".into(), "B".into(), "note".into(), "{}".into()).unwrap();
        let c = create_item_impl(&conn, "ws-1".into(), "C".into(), "note".into(), "{}".into()).unwrap();
        // Chain A — B — C with B as the hub.
        let ab = create_link_impl(&conn, a.id.clone(), b.id.clone(), "related".into()).unwrap();
        let bc = create_link_impl(&conn, b.id.clone(), c.id.clone(), "related".into()).unwrap();
        assert_eq!(live_edge(&conn, &a.id, &b.id) + live_edge(&conn, &b.id, &c.id), 2);

        // Delete hub B — both incident edges go dark.
        delete_item_impl(&conn, b.id.clone()).unwrap();
        assert_eq!(live_edge(&conn, &a.id, &b.id), 0, "A—B dark");
        assert_eq!(live_edge(&conn, &b.id, &c.id), 0, "B—C dark");

        // Restore B with both incident edges → full subgraph rebuilt, same B id.
        let restored = restore_snapshot_impl(&conn, b.clone(), vec![ab.clone(), bc.clone()]).unwrap();
        assert_eq!(restored.id, b.id, "hub keeps its UUID");
        assert_eq!(live_edge(&conn, &a.id, &b.id), 1, "A—B relit");
        assert_eq!(live_edge(&conn, &b.id, &c.id), 1, "B—C relit");
        // No phantom edges introduced.
        let total_links: i64 = conn.query_row("SELECT COUNT(*) FROM links", [], |r| r.get(0)).unwrap();
        assert_eq!(total_links, 2, "exactly the two original edges, no duplicates");
    }

    // ── Restore is idempotent: re-applying a snapshot doesn't duplicate links ──
    #[test]
    fn restore_is_idempotent_on_links() {
        let conn = setup_test_db();
        let a = create_item_impl(&conn, "ws-1".into(), "A".into(), "note".into(), "{}".into()).unwrap();
        let b = create_item_impl(&conn, "ws-1".into(), "B".into(), "note".into(), "{}".into()).unwrap();
        let link = create_link_impl(&conn, a.id.clone(), b.id.clone(), "related".into()).unwrap();
        delete_item_impl(&conn, a.id.clone()).unwrap();

        restore_snapshot_impl(&conn, a.clone(), vec![link.clone()]).unwrap();
        restore_snapshot_impl(&conn, a.clone(), vec![link.clone()]).unwrap(); // double-apply
        let links: i64 = conn.query_row("SELECT COUNT(*) FROM links", [], |r| r.get(0)).unwrap();
        assert_eq!(links, 1, "INSERT OR IGNORE keeps link unique across repeated restores");
    }

    // ── A linked item must be deletable: edges are cleared in the SAME tx so the
    //    two-phase integrity guard sees no new orphan link (regression DEBT-002). ──
    #[test]
    fn linked_item_is_deletable_when_edges_cleared() {
        let mut conn = setup_test_db();
        let a = create_item_impl(&conn, "ws-1".into(), "A".into(), "note".into(), "{}".into()).unwrap();
        let b = create_item_impl(&conn, "ws-1".into(), "B".into(), "note".into(), "{}".into()).unwrap();
        create_link_impl(&conn, a.id.clone(), b.id.clone(), "related".into()).unwrap();

        // Soft-deleting a linked item WITHOUT clearing its edge leaves an orphan link;
        // execute_two_phase's regression guard rejects it (and rolls back, so A stays live).
        let id = a.id.clone();
        let bad = execute_two_phase(&mut conn, "delete_item", "{}", |tx| {
            tx.execute("UPDATE items SET deleted = 1 WHERE id = ?", [&id]).map_err(|e| e.to_string())?;
            Ok(())
        });
        assert!(bad.is_err(), "delete without edge cleanup must be rejected by the integrity guard");
        assert!(verify_integrity_impl(&conn, a.id.clone(), true).unwrap(), "rollback kept A live");

        // Clearing the edge in the same tx passes integrity → delete succeeds.
        let id = a.id.clone();
        let good = execute_two_phase(&mut conn, "delete_item", "{}", |tx| {
            tx.execute("UPDATE items SET deleted = 1 WHERE id = ?", [&id]).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM links WHERE source_id = ?1 OR target_id = ?1", [&id]).map_err(|e| e.to_string())?;
            Ok(())
        });
        assert!(good.is_ok(), "delete with edge cleanup must pass integrity: {:?}", good.err());
        assert!(!verify_integrity_impl(&conn, a.id.clone(), true).unwrap(), "A is now deleted");
        assert_eq!(live_edge(&conn, &a.id, &b.id), 0, "edge removed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Crash-consistency certification (Phase 5)
    //
    // These prove the atomicity guarantees a crash relies on: every IPC mutation
    // commits its data AND its ledger stamp in one SQLite transaction, so an
    // interrupted/failed mutation can never leave a partially-applied DB.
    // ─────────────────────────────────────────────────────────────────────────

    // A failing apply() must roll back ALL data it wrote in the txn and mark the
    // ledger FAILED — nothing partial survives.
    #[test]
    fn two_phase_rolls_back_on_apply_error() {
        let mut conn = setup_test_db();
        let res: Result<(), String> = execute_two_phase(&mut conn, "create_item", "{}", |tx| {
            tx.execute(
                "INSERT INTO items (id, workspace_id, item_type, title, metadata) VALUES ('x','ws-1','task','Half','{}')",
                [],
            ).map_err(|e| e.to_string())?;
            Err("boom mid-apply".into()) // simulate failure after a write
        });
        assert!(res.is_err());
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE id='x'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "the row written before the error must be rolled back");
        let status: String = conn.query_row(
            "SELECT status FROM mutation_ledger WHERE command_type='create_item' ORDER BY created_at DESC LIMIT 1",
            [], |r| r.get(0)).unwrap();
        assert_eq!(status, "FAILED", "ledger records the failed mutation");
    }

    // An apply that REGRESSES integrity (orphans a link by soft-deleting an endpoint)
    // must abort and roll back — the integrity gate is enforced inside the txn.
    #[test]
    fn two_phase_aborts_on_integrity_regression() {
        let mut conn = setup_test_db();
        let a = create_item_impl(&conn, "ws-1".into(), "A".into(), "note".into(), "{}".into()).unwrap();
        let b = create_item_impl(&conn, "ws-1".into(), "B".into(), "note".into(), "{}".into()).unwrap();
        create_link_impl(&conn, a.id.clone(), b.id.clone(), "related".into()).unwrap();

        let aid = a.id.clone();
        let res: Result<(), String> = execute_two_phase(&mut conn, "bad_delete", "{}", |tx| {
            // Soft-deleting A leaves link a→b orphaned (source not live) → regression.
            tx.execute("UPDATE items SET deleted = 1 WHERE id = ?", [&aid]).map_err(|e| e.to_string())?;
            Ok(())
        });
        assert!(res.is_err(), "integrity regression must abort the mutation");
        let live: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE id=? AND deleted=0", [&a.id], |r| r.get(0)).unwrap();
        assert_eq!(live, 1, "A must still be live — the bad delete was rolled back");
        let status: String = conn.query_row(
            "SELECT status FROM mutation_ledger WHERE command_type='bad_delete' ORDER BY created_at DESC LIMIT 1",
            [], |r| r.get(0)).unwrap();
        assert_eq!(status, "FAILED");
    }

    // Models a hard kill mid-write: a txn dropped without commit leaves zero trace.
    // (SQLite discards the uncommitted WAL frames on the next open — this is the
    // recovery guarantee the whole app leans on.)
    #[test]
    fn interrupted_txn_leaves_no_partial_state() {
        let mut conn = setup_test_db();
        {
            let tx = conn.transaction().unwrap();
            tx.execute("INSERT INTO items (id, workspace_id, item_type, title, metadata) VALUES ('z','ws-1','task','Ghost','{}')", []).unwrap();
            // No commit — tx is dropped here, modelling the process dying mid-mutation.
        }
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE id='z'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "an uncommitted (interrupted) write must not persist");
    }

    // Happy path: a successful mutation commits BOTH the data and the COMMITTED stamp.
    #[test]
    fn two_phase_commits_data_and_ledger_together() {
        let mut conn = setup_test_db();
        let item = execute_two_phase(&mut conn, "create_item", "{}", |tx| {
            create_item_impl(tx, "ws-1".into(), "Good".into(), "task".into(), "{}".into())
        }).unwrap();
        let live: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE id=? AND deleted=0", [&item.id], |r| r.get(0)).unwrap();
        assert_eq!(live, 1);
        let status: String = conn.query_row(
            "SELECT status FROM mutation_ledger WHERE command_type='create_item' ORDER BY created_at DESC LIMIT 1",
            [], |r| r.get(0)).unwrap();
        assert_eq!(status, "COMMITTED", "successful mutation stamps COMMITTED in the same txn");
    }
}
