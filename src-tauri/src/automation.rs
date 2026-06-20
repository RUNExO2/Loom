// ─────────────────────────────────────────────────────────────────────────────
// LOOM Automation Engine — real, backend-executed, SQLite-persisted.
//
// Architecture contract honoured:
//   SQLite = truth. Automations are items (item_type 'automation'); their rule
//   lives in item.metadata as JSON. Execution history is the automation_executions
//   table. Nothing here touches localStorage or invents counters.
//
// Event flow:
//   user IPC mutation (create/update/delete/link) ──emit()──▶ dispatch()
//        └─ matches enabled automations' event triggers
//        └─ evaluates condition tree
//        └─ runs actions (each persisted through SQLite)
//        └─ writes an automation_executions row
//
// Safety (Phase 13): every action write goes through the engine's own connection,
// NOT through the IPC command layer, so actions DO NOT re-emit events. Cross-
// automation chaining is explicit (triggerAutomation action) and depth-capped.
// ─────────────────────────────────────────────────────────────────────────────

use crate::commands::{create_item_impl, create_link_impl, execute_two_phase};
use crate::AppState;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, State};

const MAX_DEPTH: u32 = 8; // recursion / chain depth cap
const MAX_AUTOMATIONS_PER_EVENT: usize = 64; // anti-storm: matched automations per single event
const MAX_ACTIONS_PER_RUN: usize = 256; // runaway-execution cap inside one automation
const HISTORY_KEEP_PER_AUTOMATION: i64 = 200; // execution-history retention cap per automation

// Tauri event broadcast to every window after an automation run mutates SQLite, so
// the frontend store reconciles its cache (the SplitBrainVerifier compares cache vs
// DB — a silent backend write would otherwise read as a divergence).
pub const DATA_CHANGED_EVENT: &str = "loom://automation-changed";

// ── Event ───────────────────────────────────────────────────────────────────
#[derive(Clone, Debug)]
pub struct Event {
    pub name: String,
    pub workspace_id: String,
    pub entity_id: Option<String>,
    pub entity_type: Option<String>,
    pub title: Option<String>,
    pub metadata: Value, // entity metadata json, or {}
}

#[derive(Clone)]
struct Automation {
    id: String,
    title: String,
    meta: Value,
}

// ── Event constructors (called from IPC mutation commands) ───────────────────
// Each mutation emits a generic Entity* event PLUS a type-specific one, so rule
// triggers can target either granularity.
fn parse_meta(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|_| json!({}))
}

fn typed_created(item_type: &str) -> Option<&'static str> {
    match item_type {
        "task" => Some("TaskCreated"),
        "note" => Some("NoteCreated"),
        "project" => Some("ProjectCreated"),
        "bookmark" => Some("BookmarkAdded"),
        "habit" => Some("HabitCreated"),
        "library" => Some("LibraryAdded"),
        "file" => Some("FileImported"),
        _ => None,
    }
}

pub fn events_for_created(item: &crate::commands::Item) -> Vec<Event> {
    let md = parse_meta(&item.metadata);
    let base = |name: &str| Event {
        name: name.to_string(),
        workspace_id: item.workspace_id.clone(),
        entity_id: Some(item.id.clone()),
        entity_type: Some(item.item_type.clone()),
        title: Some(item.title.clone()),
        metadata: md.clone(),
    };
    let mut evs = vec![base("EntityCreated")];
    if let Some(t) = typed_created(&item.item_type) {
        evs.push(base(t));
    }
    evs
}

pub fn events_for_updated(item: &crate::commands::Item) -> Vec<Event> {
    let md = parse_meta(&item.metadata);
    let base = |name: &str| Event {
        name: name.to_string(),
        workspace_id: item.workspace_id.clone(),
        entity_id: Some(item.id.clone()),
        entity_type: Some(item.item_type.clone()),
        title: Some(item.title.clone()),
        metadata: md.clone(),
    };
    let mut evs = vec![base("EntityUpdated")];
    match item.item_type.as_str() {
        "task" => {
            evs.push(base("TaskUpdated"));
            if md.get("done").and_then(|v| v.as_bool()).unwrap_or(false) {
                evs.push(base("TaskCompleted"));
            }
        }
        "project" => {
            evs.push(base("ProjectUpdated"));
            let st = md.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if st == "done" || st == "completed" {
                evs.push(base("ProjectCompleted"));
            }
        }
        "note" => evs.push(base("NoteUpdated")),
        "habit" => {
            evs.push(base("HabitUpdated"));
            if md.get("doneToday").and_then(|v| v.as_bool()).unwrap_or(false) {
                evs.push(base("HabitCompleted"));
            }
        }
        "library" => {
            evs.push(base("LibraryProgressUpdated"));
            let cur = md.pointer("/progress/current").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let total = md.pointer("/progress/total").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if total > 0.0 && cur >= total {
                evs.push(base("LibraryCompleted"));
            }
        }
        _ => {}
    }
    evs
}

pub fn events_for_deleted(id: &str, item_type: &str, workspace_id: &str) -> Vec<Event> {
    let base = |name: &str| Event {
        name: name.to_string(),
        workspace_id: workspace_id.to_string(),
        entity_id: Some(id.to_string()),
        entity_type: Some(item_type.to_string()),
        title: None,
        metadata: json!({}),
    };
    vec![base("EntityDeleted")]
}

pub fn events_for_link(source: &str, target: &str, workspace_id: &str, linked: bool) -> Vec<Event> {
    vec![Event {
        name: if linked { "EntityLinked" } else { "EntityUnlinked" }.to_string(),
        workspace_id: workspace_id.to_string(),
        entity_id: Some(source.to_string()),
        entity_type: None,
        title: None,
        metadata: json!({ "target": target }),
    }]
}

// ── Public entry: open a dedicated engine connection ──────────────────────────
// A fresh connection avoids re-entrant lock of AppState.db (std Mutex is not
// reentrant). WAL lets this coexist with the command connection.
pub fn open_engine_conn(db_path: &str) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

// Called by IPC commands AFTER they drop the db guard. Non-fatal: a failing
// automation must never break the user's underlying mutation.
pub fn emit(state: &State<'_, AppState>, events: Vec<Event>) {
    let path = state.db_path.clone();
    let app = state.app_handle.clone();
    let ws = events.first().map(|e| e.workspace_id.clone()).unwrap_or_default();
    std::thread::spawn(move || {
        if let Ok(mut conn) = open_engine_conn(&path) {
            let mut mutated = false;
            for ev in events {
                mutated |= dispatch(&mut conn, &ev, 0);
            }
            // Tell the frontend to reconcile only when the engine actually changed
            // data — avoids needless refetch storms for notify-only automations.
            if mutated {
                let _ = app.emit(DATA_CHANGED_EVENT, &ws);
            }
        }
    });
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
// Returns true if any matched automation mutated SQLite data.
pub fn dispatch(conn: &mut Connection, event: &Event, depth: u32) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    let automations = match load_enabled(conn, &event.workspace_id) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[automation] load failed: {}", e);
            return false;
        }
    };
    let mut ran = 0usize;
    let mut mutated = false;
    for auto in automations {
        if ran >= MAX_AUTOMATIONS_PER_EVENT {
            break;
        }
        if !trigger_matches_event(&auto.meta, event) {
            continue;
        }
        mutated |= run_automation(conn, &auto, event, &format!("event:{}", event.name), depth);
        ran += 1;
    }
    mutated
}

// ── Phase 7: enabled-automation cache ─────────────────────────────────────────
// load_enabled used to run on EVERY event dispatch AND every scheduler tick: it
// SELECTed every automation row for the workspace and JSON-parsed each one's
// metadata. Under a high-frequency trigger (or 1000 automations) that re-parse was
// the dominant cost. We cache the PARSED automation set per workspace and reuse it
// across events, validated by a cheap content fingerprint so the cache is never
// stale: any add/remove/edit of an automation row changes (count, total metadata
// length, id range) and forces a rebuild. The fingerprint is derived from the very
// connection passed in, so this stays correct even with the shared process-global
// map (e.g. parallel tests that all use workspace 'ws' against separate DBs).
fn automation_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, (String, Vec<Automation>)>> {
    static C: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, (String, Vec<Automation>)>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn automation_fingerprint(conn: &Connection, workspace_id: &str) -> String {
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(length(metadata)),0), COALESCE(MIN(id),''), COALESCE(MAX(id),'') \
         FROM items WHERE workspace_id = ?1 AND item_type = 'automation' AND deleted = 0",
        [workspace_id],
        |r| {
            Ok(format!(
                "{}|{}|{}|{}",
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?
            ))
        },
    )
    .unwrap_or_default()
}

fn load_enabled(conn: &Connection, workspace_id: &str) -> Result<Vec<Automation>, String> {
    let fp = automation_fingerprint(conn, workspace_id);
    {
        let cache = automation_cache().lock().map_err(|e| e.to_string())?;
        if let Some((cached_fp, autos)) = cache.get(workspace_id) {
            if *cached_fp == fp {
                return Ok(autos.clone());
            }
        }
    }
    let fresh = load_enabled_from_db(conn, workspace_id)?;
    let mut cache = automation_cache().lock().map_err(|e| e.to_string())?;
    cache.insert(workspace_id.to_string(), (fp, fresh.clone()));
    Ok(fresh)
}

fn load_enabled_from_db(conn: &Connection, workspace_id: &str) -> Result<Vec<Automation>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, metadata FROM items \
             WHERE workspace_id = ? AND item_type = 'automation' AND deleted = 0",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([workspace_id], |r| {
            let id: String = r.get(0)?;
            let title: String = r.get(1)?;
            let meta_s: String = r.get(2)?;
            Ok((id, title, meta_s))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title, meta_s) = row.map_err(|e| e.to_string())?;
        let meta: Value = serde_json::from_str(&meta_s).unwrap_or_else(|_| json!({}));
        if meta.get("on").and_then(|v| v.as_bool()).unwrap_or(false) {
            out.push(Automation { id, title, meta });
        }
    }
    Ok(out)
}

// ── Trigger matching ──────────────────────────────────────────────────────────
fn trigger_matches_event(meta: &Value, event: &Event) -> bool {
    let trig = match meta.get("trigger") {
        Some(t) => t,
        None => return false, // legacy automation, no executable trigger
    };
    let ttype = trig.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if ttype != "event" {
        return false; // interval/daily/manual fire via scheduler / run_automation
    }
    let want = trig.get("event").and_then(|v| v.as_str()).unwrap_or("");
    if want != event.name {
        return false;
    }
    // optional entity-type filter
    if let Some(et) = trig.get("entityType").and_then(|v| v.as_str()) {
        if !et.is_empty() && event.entity_type.as_deref() != Some(et) {
            return false;
        }
    }
    true
}

// ── Condition engine ──────────────────────────────────────────────────────────
// group = { "op": "AND"|"OR"|"NOT", "rules": [ ... ] }  OR a leaf:
// leaf  = { "field": "metadata.priority", "cmp": "eq", "value": "high" }
fn conditions_pass(meta: &Value, event: &Event, conn: &Connection) -> bool {
    match meta.get("conditions") {
        None => true,
        Some(Value::Null) => true,
        Some(group) => eval_group(group, event, conn),
    }
}

fn eval_group(node: &Value, event: &Event, conn: &Connection) -> bool {
    if let Some(op) = node.get("op").and_then(|v| v.as_str()) {
        let empty = vec![];
        let rules = node.get("rules").and_then(|v| v.as_array()).unwrap_or(&empty);
        match op {
            "AND" => rules.iter().all(|r| eval_group(r, event, conn)),
            "OR" => rules.is_empty() || rules.iter().any(|r| eval_group(r, event, conn)),
            "NOT" => !rules.iter().all(|r| eval_group(r, event, conn)),
            _ => true,
        }
    } else {
        eval_leaf(node, event, conn)
    }
}

fn eval_leaf(leaf: &Value, event: &Event, conn: &Connection) -> bool {
    let field = leaf.get("field").and_then(|v| v.as_str()).unwrap_or("");
    let cmp = leaf.get("cmp").and_then(|v| v.as_str()).unwrap_or("eq");
    let target = leaf.get("value").cloned().unwrap_or(Value::Null);
    let actual = resolve_field(field, event, conn);

    match cmp {
        "exists" => !actual.is_null(),
        "notExists" => actual.is_null(),
        "isDone" => actual.as_bool().unwrap_or(false),
        "hasTag" => {
            let tag = target.as_str().unwrap_or("");
            match &actual {
                Value::Array(a) => a.iter().any(|t| t.as_str() == Some(tag)),
                Value::String(s) => s.contains(tag),
                _ => false,
            }
        }
        "eq" => values_eq(&actual, &target),
        "neq" => !values_eq(&actual, &target),
        "contains" => actual
            .as_str()
            .map(|s| s.contains(target.as_str().unwrap_or("")))
            .unwrap_or(false),
        "gt" | "lt" | "gte" | "lte" => num_cmp(&actual, &target, cmp),
        _ => false,
    }
}

fn values_eq(a: &Value, b: &Value) -> bool {
    // tolerant: "5" == 5, true == "true"
    if a == b {
        return true;
    }
    match (a, b) {
        (Value::Number(_), _) | (_, Value::Number(_)) => num_cmp(a, b, "eq"),
        _ => a.to_string().trim_matches('"') == b.to_string().trim_matches('"'),
    }
}

fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn num_cmp(a: &Value, b: &Value, cmp: &str) -> bool {
    match (as_f64(a), as_f64(b)) {
        (Some(x), Some(y)) => match cmp {
            "gt" => x > y,
            "lt" => x < y,
            "gte" => x >= y,
            "lte" => x <= y,
            "eq" => (x - y).abs() < f64::EPSILON,
            _ => false,
        },
        _ => false,
    }
}

// Resolve a dotted field path against event context + DB.
// Supported roots: event.title/type/id/name, metadata.<key>(.<key>...),
// links.count (relationship check on the event entity).
fn resolve_field(field: &str, event: &Event, conn: &Connection) -> Value {
    let parts: Vec<&str> = field.split('.').collect();
    match parts.as_slice() {
        ["event", "title"] => json!(event.title),
        ["event", "type"] => json!(event.entity_type),
        ["event", "id"] => json!(event.entity_id),
        ["event", "name"] => json!(event.name),
        ["links", "count"] => {
            let id = match &event.entity_id {
                Some(i) => i,
                None => return json!(0),
            };
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM links WHERE source_id = ?1 OR target_id = ?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            json!(n)
        }
        _ if parts.first() == Some(&"metadata") => {
            let mut cur = &event.metadata;
            for key in &parts[1..] {
                match cur.get(key) {
                    Some(v) => cur = v,
                    None => return Value::Null,
                }
            }
            cur.clone()
        }
        _ => Value::Null,
    }
}

// ── Execution ─────────────────────────────────────────────────────────────────
// Returns true if the run mutated SQLite data (so callers can broadcast a refresh).
fn run_automation(
    conn: &mut Connection,
    auto: &Automation,
    event: &Event,
    source: &str,
    depth: u32,
) -> bool {
    // condition gate → SKIPPED row (real, auditable; not silent)
    if !conditions_pass(&auto.meta, event, conn) {
        let _ = record_skip(conn, auto, &event.workspace_id, source, "conditions not met");
        return false;
    }

    let exec_id = uuid::Uuid::new_v4().to_string();
    let started = chrono::Local::now();
    let _ = conn.execute(
        "INSERT INTO automation_executions \
         (id, automation_id, workspace_id, trigger_source, status, started_at) \
         VALUES (?1, ?2, ?3, ?4, 'RUNNING', ?5)",
        rusqlite::params![exec_id, auto.id, event.workspace_id, source, started.to_rfc3339()],
    );

    let empty = vec![];
    let actions = auto.meta.get("actions").and_then(|v| v.as_array()).unwrap_or(&empty);
    let mut logs: Vec<Value> = Vec::new();
    let mut count = 0usize;
    let mut last_completed: i64 = -1;
    let mut error: Option<String> = None;
    let mut mutated = false;
    // ponytail: no outer savepoint. Each action commits atomically in its own
    // SAVEPOINT (execute_two_phase). The failure model below is explicitly
    // "no cross-action rollback" — completed actions stay durable (PARTIAL),
    // the rest never run. A wrapping ROLLBACK here would undo that progress.

    for (idx, action) in actions.iter().enumerate() {
        if count >= MAX_ACTIONS_PER_RUN {
            error = Some(format!("action cap {} reached", MAX_ACTIONS_PER_RUN));
            break;
        }
        // Idempotency guard. The engine never auto-replays after a crash
        // (recover_interrupted only flips RUNNING→FAILED), but if any retry path
        // re-drives an existing run_id, an already-committed action_index is skipped
        // rather than executed a second time.
        if action_already_done(conn, &exec_id, idx as i64) {
            count += 1;
            last_completed = idx as i64;
            continue;
        }
        match exec_action(conn, action, event, depth, &mut logs) {
            Ok((stop, did_mutate)) => {
                // Durable progress: record the action and advance last_completed_index
                // BEFORE moving on, so a crash on the next action leaves an exact,
                // truthful record of what ran.
                record_action_done(conn, &exec_id, idx as i64,
                    action.get("type").and_then(|v| v.as_str()).unwrap_or("?"));
                count += 1;
                last_completed = idx as i64;
                let _ = conn.execute(
                    "UPDATE automation_executions SET last_completed_index=?1, actions_executed=?2 WHERE id=?3",
                    rusqlite::params![last_completed, count as i64, exec_id],
                );
                mutated |= did_mutate;
                if stop {
                    logs.push(json!({"action": "stop", "ok": true}));
                    break;
                }
            }
            Err(e) => {
                logs.push(json!({"error": e}));
                error = Some(e);
                break;
            }
        }
    }

    let dur = chrono::Local::now()
        .signed_duration_since(started)
        .num_milliseconds();
    // Failure model: a clean run is SUCCESS. A failed run that already committed a
    // durable side effect is PARTIAL (some actions are permanent, the rest never
    // ran); a failed run that changed nothing is FAILED. No cross-action rollback.
    let status = match (&error, mutated) {
        (None, _) => "SUCCESS",
        (Some(_), true) => "PARTIAL",
        (Some(_), false) => "FAILED",
    };
    let output = serde_json::to_string(&logs).unwrap_or_else(|_| "[]".into());
    let _ = conn.execute(
        "UPDATE automation_executions SET \
         status=?1, finished_at=?2, duration_ms=?3, actions_executed=?4, last_completed_index=?5, output=?6, error=?7 \
         WHERE id=?8",
        rusqlite::params![
            status,
            chrono::Local::now().to_rfc3339(),
            dur,
            count as i64,
            last_completed,
            output,
            error,
            exec_id
        ],
    );

    // Record the run on the automation item. SUCCESS bumps the success counter AND
    // stamps lastRun. A PARTIAL run committed durable work, so it must update lastRun
    // too (otherwise the card shows a stale "last run" and lies that nothing ran) — but
    // it is not a success, so it does not bump the counter. A FAILED run committed
    // nothing, so it is not recorded as a run at all.
    if error.is_none() {
        record_run(conn, &auto.id, true);
    } else if mutated {
        record_run(conn, &auto.id, false);
    }
    prune_history(conn, &auto.id);
    mutated
}

// Idempotency guard read: has (run_id, action_index) already committed?
fn action_already_done(conn: &Connection, run_id: &str, idx: i64) -> bool {
    conn.query_row(
        "SELECT 1 FROM automation_action_log WHERE run_id = ?1 AND action_index = ?2",
        rusqlite::params![run_id, idx],
        |_| Ok(()),
    )
    .is_ok()
}

// Durable per-action record. INSERT OR IGNORE so re-recording the same
// (run_id, action_index) is a no-op — the guard is self-consistent under retry.
fn record_action_done(conn: &Connection, run_id: &str, idx: i64, action_type: &str) {
    let _ = conn.execute(
        "INSERT OR IGNORE INTO automation_action_log (run_id, action_index, action_type, status) \
         VALUES (?1, ?2, ?3, 'DONE')",
        rusqlite::params![run_id, idx, action_type],
    );
}

// Cap execution history per automation so interval/daily schedules can't grow the
// table without bound. Keeps the newest HISTORY_KEEP_PER_AUTOMATION rows.
fn prune_history(conn: &Connection, automation_id: &str) {
    let _ = conn.execute(
        "DELETE FROM automation_executions WHERE automation_id = ?1 AND id NOT IN (\
            SELECT id FROM automation_executions WHERE automation_id = ?1 \
            ORDER BY started_at DESC LIMIT ?2)",
        rusqlite::params![automation_id, HISTORY_KEEP_PER_AUTOMATION],
    );
    // Drop action-log rows whose run was pruned, so the log can't outgrow history.
    let _ = conn.execute(
        "DELETE FROM automation_action_log WHERE run_id NOT IN (SELECT id FROM automation_executions)",
        [],
    );
}

// One-shot startup recovery: any execution still marked RUNNING was interrupted by a
// crash/restart (the engine never leaves a row RUNNING on a clean finish), so close it
// out instead of leaving a phantom in-flight run in the stats. Post-E9 each action
// commits durably as it runs (and actions_executed is updated in autocommit), so a run
// that already committed work is PARTIAL — marking it FAILED would lie that nothing
// happened while those items live on in the user's data/graph. Zero work → FAILED.
pub fn recover_interrupted(conn: &Connection) {
    let _ = conn.execute(
        "UPDATE automation_executions SET \
         status = CASE WHEN actions_executed > 0 THEN 'PARTIAL' ELSE 'FAILED' END, \
         error = COALESCE(error, 'interrupted: app restart'), \
         finished_at = COALESCE(finished_at, started_at) \
         WHERE status = 'RUNNING'",
        [],
    );
}

fn record_skip(
    conn: &Connection,
    auto: &Automation,
    workspace_id: &str,
    source: &str,
    reason: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO automation_executions \
         (id, automation_id, workspace_id, trigger_source, status, started_at, finished_at, duration_ms, actions_executed, output) \
         VALUES (?1, ?2, ?3, ?4, 'SKIPPED', ?5, ?5, 0, 0, ?6)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            auto.id,
            workspace_id,
            source,
            chrono::Local::now().to_rfc3339(),
            json!([{ "skipped": reason }]).to_string(),
        ],
    )
    .map_err(|e| e.to_string())?;
    prune_history(conn, &auto.id);
    Ok(())
}

// Real run counter — replaces the old frozen seed number. Stored back in metadata.
// Stamp lastRun on the automation item, and bump the success counter when this was a
// clean (SUCCESS) run. PARTIAL runs pass bump_count=false: they update lastRun but the
// `runs` counter stays a count of fully-successful completions.
fn record_run(conn: &Connection, automation_id: &str, bump_count: bool) {
    let meta_s: String = match conn.query_row(
        "SELECT metadata FROM items WHERE id = ?",
        [automation_id],
        |r| r.get(0),
    ) {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut meta: Value = serde_json::from_str(&meta_s).unwrap_or_else(|_| json!({}));
    if bump_count {
        let runs = meta.get("runs").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        meta["runs"] = json!(runs);
    }
    meta["lastRun"] = json!(chrono::Local::now().to_rfc3339());
    let _ = conn.execute(
        "UPDATE items SET metadata = ?1 WHERE id = ?2",
        rusqlite::params![meta.to_string(), automation_id],
    );
}

// Resolve "$event.entityId" / "$event.workspaceId" / literal.
fn resolve_ref(raw: &str, event: &Event) -> Option<String> {
    match raw {
        "$event.entityId" => event.entity_id.clone(),
        "$event.workspaceId" => Some(event.workspace_id.clone()),
        "$event.title" => event.title.clone(),
        other => Some(other.to_string()),
    }
}

// Returns Ok((stop_flag, mutated_flag)). Err halts the run as FAILED.
fn exec_action(
    conn: &mut Connection,
    action: &Value,
    event: &Event,
    depth: u32,
    logs: &mut Vec<Value>,
) -> Result<(bool, bool), String> {
    let atype = action.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match atype {
        "createTask" | "createNote" | "createProject" | "createItem" => {
            let item_type = match atype {
                "createTask" => "task",
                "createNote" => "note",
                "createProject" => "project",
                _ => action.get("itemType").and_then(|v| v.as_str()).unwrap_or("task"),
            };
            let title = action
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled")
                .to_string();
            let meta = action.get("meta").cloned().unwrap_or_else(|| json!({}));
            let ws = event.workspace_id.clone();
            let created = execute_two_phase(conn, "automation_create", &title, |tx| {
                create_item_impl(tx, ws.clone(), title.clone(), item_type.to_string(), meta.to_string())
            })?;
            logs.push(json!({"action": atype, "createdId": created.id, "title": created.title}));
            Ok((false, true))
        }
        "updateMetadata" | "archiveEntity" => {
            let target = action
                .get("target")
                .and_then(|v| v.as_str())
                .and_then(|r| resolve_ref(r, event))
                .ok_or("updateMetadata: unresolved target")?;
            let cur_s: String = conn
                .query_row("SELECT metadata FROM items WHERE id = ? AND deleted = 0", [&target], |r| r.get(0))
                .map_err(|_| format!("target {} not found", target))?;
            let mut cur: Value = serde_json::from_str(&cur_s).unwrap_or_else(|_| json!({}));
            let patch = if atype == "archiveEntity" {
                json!({ "archived": true })
            } else {
                action.get("patch").cloned().unwrap_or_else(|| json!({}))
            };
            if let (Some(obj), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
                for (k, v) in p {
                    obj.insert(k.clone(), v.clone());
                }
            }
            let new_s = cur.to_string();
            let tgt = target.clone();
            execute_two_phase(conn, "automation_update_meta", &tgt, |tx| {
                tx.execute("UPDATE items SET metadata = ?1 WHERE id = ?2", rusqlite::params![new_s, tgt])
                    .map_err(|e| e.to_string())?;
                Ok(())
            })?;
            logs.push(json!({"action": atype, "target": target}));
            Ok((false, true))
        }
        "deleteEntity" => {
            let target = action
                .get("target")
                .and_then(|v| v.as_str())
                .and_then(|r| resolve_ref(r, event))
                .ok_or("deleteEntity: unresolved target")?;
            let tgt = target.clone();
            execute_two_phase(conn, "automation_delete", &tgt, |tx| {
                tx.execute("UPDATE items SET deleted = 1 WHERE id = ? AND deleted = 0", [&tgt])
                    .map_err(|e| e.to_string())?;
                Ok(())
            })?;
            logs.push(json!({"action": "deleteEntity", "target": target}));
            Ok((false, true))
        }
        "createLink" => {
            let s = action.get("source").and_then(|v| v.as_str()).and_then(|r| resolve_ref(r, event))
                .ok_or("createLink: unresolved source")?;
            let t = action.get("target").and_then(|v| v.as_str()).and_then(|r| resolve_ref(r, event))
                .ok_or("createLink: unresolved target")?;
            let rel = action.get("rel").and_then(|v| v.as_str()).unwrap_or("related").to_string();
            let (s2, t2, r2) = (s.clone(), t.clone(), rel.clone());
            execute_two_phase(conn, "automation_link", &s2, |tx| {
                create_link_impl(tx, s2.clone(), t2.clone(), r2.clone()).map(|_| ())
            })?;
            logs.push(json!({"action": "createLink", "source": s, "target": t, "rel": rel}));
            Ok((false, true))
        }
        "deleteLink" => {
            let s = action.get("source").and_then(|v| v.as_str()).and_then(|r| resolve_ref(r, event))
                .ok_or("deleteLink: unresolved source")?;
            let t = action.get("target").and_then(|v| v.as_str()).and_then(|r| resolve_ref(r, event))
                .ok_or("deleteLink: unresolved target")?;
            let rel = action.get("rel").and_then(|v| v.as_str()).unwrap_or("related").to_string();
            let (s2, t2, r2) = (s.clone(), t.clone(), rel.clone());
            execute_two_phase(conn, "automation_unlink", &s2, |tx| {
                tx.execute(
                    "DELETE FROM links WHERE relationship_type = ?3 AND \
                     ((source_id = ?1 AND target_id = ?2) OR (source_id = ?2 AND target_id = ?1))",
                    [&s2, &t2, &r2],
                ).map_err(|e| e.to_string())?;
                Ok(())
            })?;
            logs.push(json!({"action": "deleteLink", "source": s, "target": t}));
            Ok((false, true))
        }
        "notify" => {
            let msg = action.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
            logs.push(json!({"action": "notify", "message": msg}));
            Ok((false, false))
        }
        "delay" | "wait" => {
            let ms = action.get("ms").and_then(|v| v.as_u64()).unwrap_or(0).min(10_000);
            std::thread::sleep(std::time::Duration::from_millis(ms));
            logs.push(json!({"action": "delay", "ms": ms}));
            Ok((false, false))
        }
        "enableAutomation" | "disableAutomation" => {
            let id = action.get("automationId").and_then(|v| v.as_str()).ok_or("missing automationId")?;
            let on = atype == "enableAutomation";
            let cur_s: String = conn.query_row("SELECT metadata FROM items WHERE id = ?", [id], |r| r.get(0))
                .map_err(|_| "automation not found".to_string())?;
            let mut m: Value = serde_json::from_str(&cur_s).unwrap_or_else(|_| json!({}));
            m["on"] = json!(on);
            conn.execute("UPDATE items SET metadata = ?1 WHERE id = ?2", rusqlite::params![m.to_string(), id])
                .map_err(|e| e.to_string())?;
            logs.push(json!({"action": atype, "automationId": id}));
            Ok((false, true))
        }
        "triggerAutomation" => {
            // Explicit chaining — depth-capped to prevent circular automation storms.
            let id = action.get("automationId").and_then(|v| v.as_str()).ok_or("missing automationId")?;
            if depth + 1 > MAX_DEPTH {
                return Err(format!("chain depth cap {} reached", MAX_DEPTH));
            }
            // Only chain into a real, enabled automation in the SAME workspace. Chaining
            // must never resurrect a disabled rule or cross workspace boundaries.
            let (title, chained_ws, meta_s): (String, String, String) = conn
                .query_row(
                    "SELECT title, workspace_id, metadata FROM items \
                     WHERE id = ? AND item_type = 'automation' AND deleted = 0",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(|_| "chained automation not found".to_string())?;
            if chained_ws != event.workspace_id {
                return Err(format!("chained automation {} is in a different workspace", id));
            }
            let meta: Value = serde_json::from_str(&meta_s).unwrap_or_else(|_| json!({}));
            if !meta.get("on").and_then(|v| v.as_bool()).unwrap_or(false) {
                logs.push(json!({"action": "triggerAutomation", "automationId": id, "skipped": "disabled"}));
                return Ok((false, false));
            }
            let chained = Automation { id: id.to_string(), title, meta };
            let synthetic = Event {
                name: "AutomationTriggered".into(),
                workspace_id: event.workspace_id.clone(),
                entity_id: event.entity_id.clone(),
                entity_type: event.entity_type.clone(),
                title: event.title.clone(),
                metadata: event.metadata.clone(),
            };
            let chained_mutated = run_automation(conn, &chained, &synthetic, "chain", depth + 1);
            logs.push(json!({"action": "triggerAutomation", "automationId": id}));
            Ok((false, chained_mutated))
        }
        "stop" | "stopExecution" => Ok((true, false)),
        other => Err(format!("unknown action type '{}'", other)),
    }
}

// ── Scheduler (Phase 4: interval + daily triggers) ────────────────────────────
// Called on a fixed tick by the background thread. Each automation's "due" state
// is derived from its last execution in SQLite — no in-memory timers to drift.
// Returns true if any scheduled run mutated SQLite data.
pub fn scheduler_tick(conn: &mut Connection) -> bool {
    let workspaces: Vec<String> = {
        let mut stmt = match conn.prepare("SELECT id FROM workspaces") {
            Ok(s) => s,
            Err(_) => return false,
        };
        let rows = match stmt.query_map([], |r| r.get::<_, String>(0)) {
            Ok(r) => r,
            Err(_) => return false,
        };
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut mutated = false;
    for ws in workspaces {
        let autos = match load_enabled(conn, &ws) {
            Ok(a) => a,
            Err(_) => continue,
        };
        for auto in autos {
            let trig = match auto.meta.get("trigger") {
                Some(t) => t,
                None => continue,
            };
            let ttype = trig.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let due = match ttype {
                "interval" => {
                    let secs = trig.get("intervalSecs").and_then(|v| v.as_i64()).unwrap_or(0);
                    secs > 0 && interval_due(conn, &auto.id, secs)
                }
                "daily" => {
                    let t = trig.get("time").and_then(|v| v.as_str()).unwrap_or("");
                    daily_due(conn, &auto.id, t)
                }
                _ => false,
            };
            if due {
                let ev = Event {
                    name: "Scheduled".into(),
                    workspace_id: ws.clone(),
                    entity_id: None,
                    entity_type: None,
                    title: Some(auto.title.clone()),
                    metadata: json!({}),
                };
                mutated |= run_automation(conn, &auto, &ev, &format!("schedule:{}", ttype), 0);
            }
        }
    }
    // Recurring tasks ride the same tick: a completed recurring task spawns its next
    // instance. Folded into the scheduler's mutated flag so the frontend reconciles.
    mutated |= recurring_tick(conn);
    mutated
}

// ── Recurring tasks ───────────────────────────────────────────────────────────
// A task carries a recurrence rule in its metadata:
//   metadata.recurrence = { "unit": "day"|"week"|"month"|"year", "every": <int ≥1> }
// When the user marks such a task done, the next scheduler tick spawns the next
// instance (done=false, dueDate advanced by the rule, recurrence carried forward)
// and stamps the completed one with recurrenceSpawned=true so it never double-spawns.
// State lives entirely in SQLite — the flag makes the spawn idempotent across
// restarts, exactly like the automation scheduler derives "due" from persisted rows.

const MONTHS_ABBR: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Advance a date by `every` units. month/year clamp to the last valid day
// (Jan 31 + 1 month → Feb 28/29) via chrono's checked_add_months.
pub fn advance_date(date: chrono::NaiveDate, unit: &str, every: i64) -> Option<chrono::NaiveDate> {
    let n = every.max(1);
    match unit {
        "day" => date.checked_add_signed(chrono::Duration::days(n)),
        "week" => date.checked_add_signed(chrono::Duration::days(n * 7)),
        "month" => date.checked_add_months(chrono::Months::new(n as u32)),
        "year" => date.checked_add_months(chrono::Months::new((n as u32) * 12)),
        _ => None,
    }
}

fn due_label(date: chrono::NaiveDate) -> String {
    use chrono::Datelike;
    format!("{} {}", MONTHS_ABBR[date.month0() as usize], date.day())
}

// Scan every workspace for completed recurring tasks that haven't spawned their
// successor yet, and create it. Returns true if anything was created.
pub fn recurring_tick(conn: &mut Connection) -> bool {
    let candidates: Vec<(String, String, String, String)> = {
        let mut stmt = match conn.prepare(
            "SELECT id, workspace_id, title, metadata FROM items \
             WHERE item_type = 'task' AND deleted = 0 AND json_valid(metadata) \
               AND json_extract(metadata, '$.done') = 1 \
               AND json_extract(metadata, '$.recurrence') IS NOT NULL \
               AND json_extract(metadata, '$.recurrence') <> 'none' \
               AND COALESCE(json_extract(metadata, '$.recurrenceSpawned'), 0) = 0",
        ) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let rows = match stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        }) {
            Ok(r) => r,
            Err(_) => return false,
        };
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut mutated = false;
    for (id, ws, title, meta_s) in candidates {
        let meta: Value = match serde_json::from_str(&meta_s) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let rec = match meta.get("recurrence") {
            Some(r) => r,
            None => continue,
        };
        // Accept both the canonical object form { unit, every } and the legacy string
        // form ("daily"/"weekly"/"monthly"/"yearly") written by older task editors.
        let (unit, every): (String, i64) = if let Some(s) = rec.as_str() {
            match s {
                "daily" => ("day".to_string(), 1),
                "weekly" => ("week".to_string(), 1),
                "monthly" => ("month".to_string(), 1),
                "yearly" => ("year".to_string(), 1),
                _ => (String::new(), 1),
            }
        } else {
            (
                rec.get("unit").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                rec.get("every").and_then(|v| v.as_i64()).unwrap_or(1),
            )
        };

        // Base the next due on the task's dueDate; fall back to today if absent/bad.
        let base = meta
            .get("dueDate")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .unwrap_or_else(|| chrono::Local::now().date_naive());

        let next = match advance_date(base, &unit, every) {
            Some(d) => d,
            None => {
                // Unknown unit → not a valid rule. Stamp it so we don't rescan forever.
                stamp_spawned(conn, &id, &meta);
                continue;
            }
        };

        // Build the successor metadata: fresh (not done, not spawned), due advanced,
        // recurrence carried forward so the cycle continues on the next completion.
        let mut next_meta = meta.clone();
        if let Some(obj) = next_meta.as_object_mut() {
            obj.insert("done".into(), json!(false));
            obj.insert("dueDate".into(), json!(next.format("%Y-%m-%d").to_string()));
            obj.insert("due".into(), json!(due_label(next)));
            obj.remove("recurrenceSpawned");
            obj.remove("completedAt");
        }

        let ws2 = ws.clone();
        let title2 = title.clone();
        let nm = next_meta.to_string();
        let created = execute_two_phase(conn, "recurring_spawn", &title2, |tx| {
            create_item_impl(tx, ws2.clone(), title2.clone(), "task".to_string(), nm.clone())
        });
        if created.is_ok() {
            stamp_spawned(conn, &id, &meta);
            mutated = true;
        }
    }
    mutated
}

// Mark a completed recurring task as having spawned its successor (idempotency flag).
fn stamp_spawned(conn: &Connection, id: &str, meta: &Value) {
    let mut m = meta.clone();
    if let Some(obj) = m.as_object_mut() {
        obj.insert("recurrenceSpawned".into(), json!(true));
    }
    let _ = conn.execute(
        "UPDATE items SET metadata = ?1 WHERE id = ?2",
        rusqlite::params![m.to_string(), id],
    );
}

// Timestamp of the last execution ATTEMPT (any status, including SKIPPED). Scheduler
// "due" is based on attempts, not successes: a perpetually-skipping interval/daily rule
// must still consume its interval, otherwise it would re-fire and re-skip every tick.
fn last_attempt(conn: &Connection, automation_id: &str) -> Option<chrono::DateTime<chrono::Local>> {
    let s: Option<String> = conn
        .query_row(
            "SELECT started_at FROM automation_executions \
             WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1",
            [automation_id],
            |r| r.get(0),
        )
        .ok();
    s.and_then(|v| chrono::DateTime::parse_from_rfc3339(&v).ok())
        .map(|d| d.with_timezone(&chrono::Local))
}

fn interval_due(conn: &Connection, automation_id: &str, secs: i64) -> bool {
    match last_attempt(conn, automation_id) {
        None => true,
        Some(last) => {
            chrono::Local::now().signed_duration_since(last).num_seconds() >= secs
        }
    }
}

fn daily_due(conn: &Connection, automation_id: &str, hhmm: &str) -> bool {
    use chrono::{Datelike, Timelike};
    let parts: Vec<&str> = hhmm.split(':').collect();
    if parts.len() != 2 {
        return false;
    }
    let (h, m) = match (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
        (Ok(h), Ok(m)) => (h, m),
        _ => return false,
    };
    let now = chrono::Local::now();
    // must be past today's target time …
    if now.hour() < h || (now.hour() == h && now.minute() < m) {
        return false;
    }
    // … and not already attempted today (a skip still counts, so a daily rule whose
    // conditions fail doesn't retry every 30s for the rest of the day)
    match last_attempt(conn, automation_id) {
        None => true,
        Some(last) => {
            !(last.year() == now.year() && last.ordinal() == now.ordinal())
        }
    }
}

// ── IPC payloads ──────────────────────────────────────────────────────────────
#[derive(Serialize)]
pub struct ExecutionRow {
    pub id: String,
    pub automation_id: String,
    pub trigger_source: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub actions_executed: i64,
    pub last_completed_index: i64,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::database::setup_schema(&c).unwrap();
        c.execute("INSERT INTO workspaces (id, name) VALUES ('ws', 'W')", []).unwrap();
        c
    }

    fn add_automation(c: &Connection, meta: Value) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        c.execute(
            "INSERT INTO items (id, workspace_id, item_type, title, metadata) VALUES (?1,'ws','automation','A',?2)",
            rusqlite::params![id, meta.to_string()],
        ).unwrap();
        id
    }

    fn ev(name: &str, etype: &str, md: Value) -> Event {
        Event { name: name.into(), workspace_id: "ws".into(), entity_id: Some("e1".into()),
            entity_type: Some(etype.into()), title: Some("T".into()), metadata: md }
    }

    #[test]
    fn event_trigger_runs_action_and_logs() {
        let mut c = db();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [{ "type": "createTask", "title": "Followup" }]
        }));
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);

        let tasks: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE item_type='task' AND title='Followup' AND deleted=0", [], |r| r.get(0)).unwrap();
        assert_eq!(tasks, 1, "action should create a task");
        let ok: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1 AND status='SUCCESS'", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(ok, 1, "one SUCCESS execution logged");
        let runs: String = c.query_row("SELECT metadata FROM items WHERE id=?1", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&runs).unwrap()["runs"], json!(1), "runs bumped");
    }

    #[test]
    fn conditions_gate_execution() {
        let mut c = db();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskUpdated" },
            "conditions": { "op": "AND", "rules": [{ "field": "metadata.priority", "cmp": "eq", "value": "high" }] },
            "actions": [{ "type": "notify", "message": "hi" }]
        }));
        // priority low → SKIPPED
        dispatch(&mut c, &ev("TaskUpdated", "task", json!({"priority": "low"})), 0);
        let skipped: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1 AND status='SKIPPED'", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(skipped, 1);
        // priority high → SUCCESS
        dispatch(&mut c, &ev("TaskUpdated", "task", json!({"priority": "high"})), 0);
        let ok: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1 AND status='SUCCESS'", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(ok, 1);
    }

    #[test]
    fn wrong_event_does_not_match() {
        let mut c = db();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [{ "type": "notify", "message": "x" }]
        }));
        dispatch(&mut c, &ev("NoteCreated", "note", json!({})), 0);
        let n: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "non-matching event must not execute");
    }

    #[test]
    fn disabled_automation_skipped() {
        let mut c = db();
        add_automation(&c, json!({
            "on": false,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [{ "type": "createTask", "title": "X" }]
        }));
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        let tasks: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE title='X'", [], |r| r.get(0)).unwrap();
        assert_eq!(tasks, 0);
    }

    #[test]
    fn chaining_into_disabled_automation_is_blocked() {
        let mut c = db();
        // B is disabled and would create a task if run.
        let b = add_automation(&c, json!({
            "on": false,
            "trigger": { "type": "manual" },
            "actions": [{ "type": "createTask", "title": "FromB" }]
        }));
        // A is enabled and explicitly chains into B.
        add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [{ "type": "triggerAutomation", "automationId": b }]
        }));
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        // B is off → its action must NOT run.
        let from_b: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE title='FromB'", [], |r| r.get(0)).unwrap();
        assert_eq!(from_b, 0, "chaining must not run a disabled automation");
        // …but B logs no execution row of its own (it was gated before running).
        let b_runs: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1", [&b], |r| r.get(0)).unwrap();
        assert_eq!(b_runs, 0);
    }

    #[test]
    fn dispatch_reports_data_mutation() {
        let mut c = db();
        add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [{ "type": "createTask", "title": "M" }]
        }));
        assert!(dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0), "create action mutates → true");

        let mut c2 = db();
        add_automation(&c2, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [{ "type": "notify", "message": "hi" }]
        }));
        assert!(!dispatch(&mut c2, &ev("TaskCompleted", "task", json!({})), 0), "notify-only does not mutate → false");
    }

    // ── Chained actions (success path) ────────────────────────────────────────
    #[test]
    fn chaining_into_enabled_automation_runs() {
        let mut c = db();
        // B enabled, creates a task when run.
        let b = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "manual" },
            "actions": [{ "type": "createTask", "title": "FromB" }]
        }));
        // A enabled, chains into B on TaskCompleted.
        let a = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [{ "type": "triggerAutomation", "automationId": b }]
        }));
        assert!(dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0), "chain mutates via B → true");
        let from_b: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE title='FromB' AND deleted=0", [], |r| r.get(0)).unwrap();
        assert_eq!(from_b, 1, "enabled chained automation must run its action");
        // Both A and B logged a SUCCESS row.
        let a_ok: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1 AND status='SUCCESS'", [&a], |r| r.get(0)).unwrap();
        let b_ok: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1 AND status='SUCCESS'", [&b], |r| r.get(0)).unwrap();
        assert_eq!((a_ok, b_ok), (1, 1), "both parent and chained automation log SUCCESS");
    }

    // ── Multi-action sequence runs in order ───────────────────────────────────
    #[test]
    fn chained_actions_all_execute_in_order() {
        let mut c = db();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [
                { "type": "createTask", "title": "Step1" },
                { "type": "createNote", "title": "Step2" },
                { "type": "createProject", "title": "Step3" }
            ]
        }));
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        for (title, ty) in [("Step1","task"),("Step2","note"),("Step3","project")] {
            let n: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE title=?1 AND item_type=?2 AND deleted=0", rusqlite::params![title, ty], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "{} must be created", title);
        }
        let executed: i64 = c.query_row("SELECT actions_executed FROM automation_executions WHERE automation_id=?1", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(executed, 3, "all three actions counted");
    }

    // ── Failed action after a commit → PARTIAL, halts run, no success bump ─────
    #[test]
    fn failed_action_marks_run_failed_and_halts() {
        let mut c = db();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [
                { "type": "createTask", "title": "BeforeFail" },
                { "type": "bogusActionType" },
                { "type": "createTask", "title": "AfterFail" }
            ]
        }));
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        let before: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE title='BeforeFail' AND deleted=0", [], |r| r.get(0)).unwrap();
        let after: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE title='AfterFail' AND deleted=0", [], |r| r.get(0)).unwrap();
        assert_eq!(before, 1, "action before failure committed");
        assert_eq!(after, 0, "action after failure must not run (halt)");
        let (status, err): (String, Option<String>) = c.query_row(
            "SELECT status, error FROM automation_executions WHERE automation_id=?1", [&aid], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        // BeforeFail committed a durable side effect, then the run failed → PARTIAL.
        assert_eq!(status, "PARTIAL");
        assert!(err.unwrap().contains("unknown action type"), "error message recorded");
        // A PARTIAL run must NOT bump the success counter, but it DID run and commit
        // durable work, so lastRun must be stamped (the card can't claim it never ran).
        let meta: Value = serde_json::from_str(&c.query_row("SELECT metadata FROM items WHERE id=?1", [&aid], |r| r.get::<_,String>(0)).unwrap()).unwrap();
        assert_eq!(meta.get("runs").and_then(|v| v.as_i64()).unwrap_or(0), 0, "partial run does not bump success counter");
        assert!(meta.get("lastRun").and_then(|v| v.as_str()).is_some(), "partial run stamps lastRun");
    }

    // ── stop action halts remaining actions, still SUCCESS ────────────────────
    #[test]
    fn stop_action_halts_remaining() {
        let mut c = db();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [
                { "type": "createTask", "title": "Pre" },
                { "type": "stop" },
                { "type": "createTask", "title": "Post" }
            ]
        }));
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        let pre: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE title='Pre' AND deleted=0", [], |r| r.get(0)).unwrap();
        let post: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE title='Post' AND deleted=0", [], |r| r.get(0)).unwrap();
        assert_eq!((pre, post), (1, 0), "stop halts before Post");
        let status: String = c.query_row("SELECT status FROM automation_executions WHERE automation_id=?1", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(status, "SUCCESS", "stop is a clean halt, not a failure");
    }

    // ── Restart recovery: RUNNING rows flipped to FAILED ──────────────────────
    #[test]
    fn recover_interrupted_closes_running_rows() {
        let c = db();
        let aid = add_automation(&c, json!({ "on": true }));
        c.execute(
            "INSERT INTO automation_executions (id, automation_id, workspace_id, trigger_source, status, started_at) \
             VALUES ('stuck', ?1, 'ws', 'event:x', 'RUNNING', ?2)",
            rusqlite::params![aid, chrono::Local::now().to_rfc3339()],
        ).unwrap();
        recover_interrupted(&c);
        let (status, err, fin): (String, Option<String>, Option<String>) = c.query_row(
            "SELECT status, error, finished_at FROM automation_executions WHERE id='stuck'",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(status, "FAILED", "interrupted run closed as FAILED");
        assert!(err.unwrap().contains("interrupted"), "interrupted reason recorded");
        assert!(fin.is_some(), "finished_at backfilled");
        // Idempotent: a clean (already-finished) row is untouched on a second pass.
        recover_interrupted(&c);
        let still: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE status='RUNNING'", [], |r| r.get(0)).unwrap();
        assert_eq!(still, 0, "no RUNNING rows remain");
    }

    // ── Restart recovery: a run that committed work before crashing → PARTIAL ──
    #[test]
    fn recover_interrupted_partial_when_actions_committed() {
        let c = db();
        let aid = add_automation(&c, json!({ "on": true }));
        c.execute(
            "INSERT INTO automation_executions (id, automation_id, workspace_id, trigger_source, status, started_at, actions_executed) \
             VALUES ('stuck', ?1, 'ws', 'event:x', 'RUNNING', ?2, 2)",
            rusqlite::params![aid, chrono::Local::now().to_rfc3339()],
        ).unwrap();
        recover_interrupted(&c);
        let status: String = c.query_row(
            "SELECT status FROM automation_executions WHERE id='stuck'", [], |r| r.get(0)).unwrap();
        assert_eq!(status, "PARTIAL", "durable progress before crash → PARTIAL, not FAILED");
    }

    // ── Scheduler: interval trigger fires once, then waits out its interval ────
    #[test]
    fn interval_scheduler_fires_once_then_waits() {
        let mut c = db();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "interval", "intervalSecs": 3600 },
            "actions": [{ "type": "notify", "message": "tick" }]
        }));
        // No prior attempt → due immediately.
        scheduler_tick(&mut c);
        let n1: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(n1, 1, "first tick fires the interval");
        // Immediate second tick: last attempt < 3600s ago → not due.
        scheduler_tick(&mut c);
        let n2: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(n2, 1, "second tick within interval must not re-fire");
    }

    // ── Scheduler: daily trigger past-due fires once per day ──────────────────
    #[test]
    fn daily_scheduler_fires_once_per_day() {
        let mut c = db();
        // 00:00 is always already past today → due if not yet attempted today.
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "daily", "time": "00:00" },
            "actions": [{ "type": "notify", "message": "daily" }]
        }));
        scheduler_tick(&mut c);
        scheduler_tick(&mut c);
        let n: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "daily fires once, not every tick");
    }

    // ── Runaway: self-chain terminates at depth cap (no stack overflow) ───────
    #[test]
    fn self_chain_terminates_at_depth_cap() {
        let mut c = db();
        let aid = uuid::Uuid::new_v4().to_string();
        // Automation that chains into itself — would loop forever without the cap.
        c.execute(
            "INSERT INTO items (id, workspace_id, item_type, title, metadata) VALUES (?1,'ws','automation','Loop',?2)",
            rusqlite::params![aid, json!({
                "on": true,
                "trigger": { "type": "event", "event": "TaskCompleted" },
                "actions": [{ "type": "triggerAutomation", "automationId": aid }]
            }).to_string()],
        ).unwrap();
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        // Deepest run hits the cap → at least one FAILED row; total runs bounded by MAX_DEPTH.
        let total: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1", [&aid], |r| r.get(0)).unwrap();
        assert!(total >= 1 && total <= (MAX_DEPTH as i64 + 1), "self-chain bounded by depth cap, got {}", total);
        let failed: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1 AND status='FAILED'", [&aid], |r| r.get(0)).unwrap();
        assert!(failed >= 1, "depth cap surfaces as a FAILED run");
    }

    // ── Runaway: action cap inside one run ────────────────────────────────────
    #[test]
    fn action_cap_bounds_single_run() {
        let mut c = db();
        let actions: Vec<Value> = (0..MAX_ACTIONS_PER_RUN + 50)
            .map(|_| json!({ "type": "notify", "message": "x" }))
            .collect();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": actions
        }));
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        let (status, executed): (String, i64) = c.query_row(
            "SELECT status, actions_executed FROM automation_executions WHERE automation_id=?1", [&aid], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(executed, MAX_ACTIONS_PER_RUN as i64, "executed count capped");
        assert_eq!(status, "FAILED", "hitting the action cap is a FAILED run");
    }

    // ── Runaway: anti-storm cap on automations matched per single event ───────
    #[test]
    fn anti_storm_caps_automations_per_event() {
        let mut c = db();
        // 70 automations all match the same event; cap is 64.
        for _ in 0..(MAX_AUTOMATIONS_PER_EVENT + 6) {
            add_automation(&c, json!({
                "on": true,
                "trigger": { "type": "event", "event": "TaskCompleted" },
                "actions": [{ "type": "notify", "message": "x" }]
            }));
        }
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        let runs: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions", [], |r| r.get(0)).unwrap();
        assert_eq!(runs, MAX_AUTOMATIONS_PER_EVENT as i64, "no more than the cap may run for one event");
    }

    // ── History retention cap per automation ──────────────────────────────────
    #[test]
    fn history_pruned_to_retention_cap() {
        let mut c = db();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [{ "type": "notify", "message": "x" }]
        }));
        // Fire more than the retention cap; each run prunes back down.
        for _ in 0..(HISTORY_KEEP_PER_AUTOMATION + 25) {
            dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        }
        let kept: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(kept, HISTORY_KEEP_PER_AUTOMATION, "history bounded by retention cap");
    }

    // ── Stress: scheduler throughput over large automation sets ───────────────
    fn stress_scheduler(n: usize) {
        let mut c = db();
        for i in 0..n {
            // Distinct intervals are irrelevant (all due on first tick); notify keeps
            // the action cheap so we measure dispatch+persistence overhead, not work.
            c.execute(
                "INSERT INTO items (id, workspace_id, item_type, title, metadata) VALUES (?1,'ws','automation',?2,?3)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    format!("auto-{}", i),
                    json!({
                        "on": true,
                        "trigger": { "type": "interval", "intervalSecs": 3600 },
                        "actions": [{ "type": "notify", "message": "x" }]
                    }).to_string()
                ],
            ).unwrap();
        }
        let start = std::time::Instant::now();
        scheduler_tick(&mut c);
        let elapsed = start.elapsed();
        let ran: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions", [], |r| r.get(0)).unwrap();
        assert_eq!(ran, n as i64, "every due automation in the set fired exactly once");
        eprintln!("[stress] {:>4} automations  scheduler_tick = {:>7.2?}  ({:.1} runs/s)",
            n, elapsed, n as f64 / elapsed.as_secs_f64());
        // Generous ceiling — guards against accidental O(n^2) regressions, not a perf SLA.
        assert!(elapsed.as_secs() < 30, "scheduler_tick for {} automations took too long: {:?}", n, elapsed);
    }

    #[test]
    fn stress_100_automations() { stress_scheduler(100); }
    #[test]
    fn stress_500_automations() { stress_scheduler(500); }
    #[test]
    fn stress_1000_automations() { stress_scheduler(1000); }

    // ── Recurring tasks ───────────────────────────────────────────────────────
    fn nd(s: &str) -> chrono::NaiveDate {
        chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn advance_date_handles_each_unit_and_month_clamp() {
        assert_eq!(advance_date(nd("2026-06-19"), "day", 1), Some(nd("2026-06-20")));
        assert_eq!(advance_date(nd("2026-06-19"), "week", 2), Some(nd("2026-07-03")));
        assert_eq!(advance_date(nd("2026-01-31"), "month", 1), Some(nd("2026-02-28"))); // clamp
        assert_eq!(advance_date(nd("2026-06-19"), "year", 1), Some(nd("2027-06-19")));
        assert_eq!(advance_date(nd("2026-06-19"), "bogus", 1), None);
        assert_eq!(advance_date(nd("2026-06-19"), "day", 0), Some(nd("2026-06-20"))); // every<1 → 1
    }

    fn add_task(c: &Connection, meta: Value) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        c.execute(
            "INSERT INTO items (id, workspace_id, item_type, title, metadata) VALUES (?1,'ws','task','Water plants',?2)",
            rusqlite::params![id, meta.to_string()],
        ).unwrap();
        id
    }

    #[test]
    fn recurring_done_task_spawns_next_and_stamps_original() {
        let mut c = db();
        let id = add_task(&c, json!({
            "done": true, "dueDate": "2026-06-19",
            "recurrence": { "unit": "day", "every": 2 }, "priority": "med"
        }));
        assert!(recurring_tick(&mut c), "spawn mutates");

        // Original is stamped so it never double-spawns.
        let orig: Value = serde_json::from_str(&c.query_row("SELECT metadata FROM items WHERE id=?1", [&id], |r| r.get::<_,String>(0)).unwrap()).unwrap();
        assert_eq!(orig["recurrenceSpawned"], json!(true));

        // Exactly one successor: not done, due advanced by the rule, recurrence carried.
        let next: Value = serde_json::from_str(&c.query_row(
            "SELECT metadata FROM items WHERE item_type='task' AND id<>?1 AND deleted=0", [&id], |r| r.get::<_,String>(0)).unwrap()).unwrap();
        assert_eq!(next["done"], json!(false));
        assert_eq!(next["dueDate"], json!("2026-06-21"));
        assert_eq!(next["priority"], json!("med"), "fields carried forward");
        assert!(next.get("recurrenceSpawned").is_none(), "successor is fresh");
    }

    #[test]
    fn recurring_spawn_is_idempotent() {
        let mut c = db();
        add_task(&c, json!({
            "done": true, "dueDate": "2026-06-19",
            "recurrence": { "unit": "week", "every": 1 }
        }));
        recurring_tick(&mut c);
        assert!(!recurring_tick(&mut c), "second pass spawns nothing");
        let tasks: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE item_type='task' AND deleted=0", [], |r| r.get(0)).unwrap();
        assert_eq!(tasks, 2, "one original + one successor, no duplicates");
    }

    #[test]
    fn legacy_string_recurrence_still_spawns() {
        let mut c = db();
        // Older task editors stored recurrence as a bare string.
        add_task(&c, json!({ "done": true, "dueDate": "2026-06-19", "recurrence": "weekly" }));
        assert!(recurring_tick(&mut c), "string 'weekly' recurrence spawns");
        let next: Value = serde_json::from_str(&c.query_row(
            "SELECT metadata FROM items WHERE item_type='task' AND deleted=0 AND json_extract(metadata,'$.done')=0",
            [], |r| r.get::<_,String>(0)).unwrap()).unwrap();
        assert_eq!(next["dueDate"], json!("2026-06-26"), "advanced one week");
    }

    #[test]
    fn recurrence_none_string_is_ignored() {
        let mut c = db();
        add_task(&c, json!({ "done": true, "recurrence": "none" }));
        assert!(!recurring_tick(&mut c), "'none' is not a recurrence");
    }

    #[test]
    fn non_recurring_or_open_tasks_are_ignored() {
        let mut c = db();
        add_task(&c, json!({ "done": true })); // no recurrence
        add_task(&c, json!({ "done": false, "recurrence": { "unit": "day", "every": 1 } })); // not done
        assert!(!recurring_tick(&mut c), "nothing to spawn");
        let tasks: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE item_type='task' AND deleted=0", [], |r| r.get(0)).unwrap();
        assert_eq!(tasks, 2, "no successors created");
    }

    // ── Safeguard #2: run-level consistency ───────────────────────────────────

    // Failure after a committed side effect → PARTIAL, with an exact, ordered,
    // durable record of which actions ran and which never did.
    #[test]
    fn partial_run_records_durable_progress() {
        let mut c = db();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [
                { "type": "createTask", "title": "A0" },
                { "type": "createNote", "title": "A1" },
                { "type": "bogusAction" },
                { "type": "createTask", "title": "A3" }
            ]
        }));
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        let (run_id, status, lci, executed): (String, String, i64, i64) = c.query_row(
            "SELECT id, status, last_completed_index, actions_executed FROM automation_executions WHERE automation_id=?1",
            [&aid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
        assert_eq!(status, "PARTIAL", "failed after a mutation → PARTIAL");
        assert_eq!(lci, 1, "indices 0 and 1 completed, index 2 failed");
        assert_eq!(executed, 2);
        // Durable per-action log: exactly the two committed actions, in order.
        let log: Vec<(i64, String)> = {
            let mut s = c.prepare("SELECT action_index, action_type FROM automation_action_log WHERE run_id=?1 ORDER BY action_index").unwrap();
            s.query_map([&run_id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().filter_map(|r| r.ok()).collect()
        };
        assert_eq!(log, vec![(0, "createTask".to_string()), (1, "createNote".to_string())]);
        // A3 (after the failure point) never ran.
        let a3: i64 = c.query_row("SELECT COUNT(*) FROM items WHERE title='A3'", [], |r| r.get(0)).unwrap();
        assert_eq!(a3, 0, "action after failure must not run");
    }

    // Crash mid-run that had committed work: RUNNING→PARTIAL on restart (the durable
    // actions are real), executed-action history preserved exactly as-is, NOT replayed.
    #[test]
    fn crash_recovery_preserves_action_log_and_does_not_replay() {
        let c = db();
        let aid = add_automation(&c, json!({ "on": true }));
        c.execute(
            "INSERT INTO automation_executions \
             (id, automation_id, workspace_id, trigger_source, status, started_at, last_completed_index, actions_executed) \
             VALUES ('r1', ?1, 'ws', 'event:x', 'RUNNING', ?2, 1, 2)",
            rusqlite::params![aid, chrono::Local::now().to_rfc3339()],
        ).unwrap();
        c.execute(
            "INSERT INTO automation_action_log (run_id, action_index, action_type) \
             VALUES ('r1', 0, 'createTask'), ('r1', 1, 'createNote')",
            [],
        ).unwrap();
        recover_interrupted(&c);
        let (status, lci): (String, i64) = c.query_row(
            "SELECT status, last_completed_index FROM automation_executions WHERE id='r1'",
            [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(status, "PARTIAL", "interrupted run that committed work → PARTIAL");
        assert_eq!(lci, 1, "progress index preserved exactly as-is");
        let logn: i64 = c.query_row("SELECT COUNT(*) FROM automation_action_log WHERE run_id='r1'", [], |r| r.get(0)).unwrap();
        assert_eq!(logn, 2, "executed-action history preserved, not cleared or replayed");
    }

    // Idempotency guard: an action_index already committed for a run_id is never
    // re-executed, and re-recording it is a no-op.
    #[test]
    fn idempotency_guard_skips_already_done_action() {
        let c = db();
        assert!(!action_already_done(&c, "run1", 0), "unseen action not done");
        record_action_done(&c, "run1", 0, "createTask");
        assert!(action_already_done(&c, "run1", 0), "recorded action seen as done");
        record_action_done(&c, "run1", 0, "createTask"); // OR IGNORE
        let n: i64 = c.query_row("SELECT COUNT(*) FROM automation_action_log WHERE run_id='run1'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "duplicate record ignored — guard is self-consistent");
    }

    // Rerunning an automation is a fresh run (new run_id) and is expected to act
    // again — but each run's own actions are logged exactly once, never doubled.
    #[test]
    fn rerun_creates_independent_run_without_doubling_within_run() {
        let mut c = db();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": [{ "type": "createTask", "title": "R" }]
        }));
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        let runs: i64 = c.query_row("SELECT COUNT(*) FROM automation_executions WHERE automation_id=?1", [&aid], |r| r.get(0)).unwrap();
        assert_eq!(runs, 2, "two events → two independent runs");
        // Each run logged its single action exactly once (no within-run duplication).
        let bad: i64 = c.query_row(
            "SELECT COUNT(*) FROM (SELECT run_id FROM automation_action_log GROUP BY run_id, action_index HAVING COUNT(*) > 1)",
            [], |r| r.get(0)).unwrap();
        assert_eq!(bad, 0, "no (run_id, action_index) ever logged twice");
    }

    // Large single run: hundreds of actions execute strictly in order, each logged
    // once, run completes SUCCESS.
    #[test]
    fn large_single_run_executes_in_order_within_cap() {
        let mut c = db();
        let n = 250usize; // < MAX_ACTIONS_PER_RUN
        let actions: Vec<Value> = (0..n).map(|_| json!({ "type": "notify", "message": "x" })).collect();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": actions
        }));
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        let (run_id, status, lci, executed): (String, String, i64, i64) = c.query_row(
            "SELECT id, status, last_completed_index, actions_executed FROM automation_executions WHERE automation_id=?1",
            [&aid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
        assert_eq!(status, "SUCCESS");
        assert_eq!(executed, n as i64);
        assert_eq!(lci, (n - 1) as i64);
        let indices: Vec<i64> = {
            let mut s = c.prepare("SELECT action_index FROM automation_action_log WHERE run_id=?1 ORDER BY action_index").unwrap();
            s.query_map([&run_id], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
        };
        assert_eq!(indices, (0..n as i64).collect::<Vec<_>>(), "every action logged once, strictly ordered");
    }

    // 1000-action run is bounded by the action cap and fails cleanly; the action log
    // is bounded too (no unbounded growth).
    #[test]
    fn huge_run_caps_cleanly_at_action_limit() {
        let mut c = db();
        let actions: Vec<Value> = (0..1000).map(|_| json!({ "type": "notify", "message": "x" })).collect();
        let aid = add_automation(&c, json!({
            "on": true,
            "trigger": { "type": "event", "event": "TaskCompleted" },
            "actions": actions
        }));
        dispatch(&mut c, &ev("TaskCompleted", "task", json!({})), 0);
        let (run_id, status, executed): (String, String, i64) = c.query_row(
            "SELECT id, status, actions_executed FROM automation_executions WHERE automation_id=?1",
            [&aid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(executed, MAX_ACTIONS_PER_RUN as i64, "1000-action run bounded by cap");
        assert_eq!(status, "FAILED", "hitting the cap with no mutation is FAILED");
        let logn: i64 = c.query_row("SELECT COUNT(*) FROM automation_action_log WHERE run_id=?1", [&run_id], |r| r.get(0)).unwrap();
        assert_eq!(logn, MAX_ACTIONS_PER_RUN as i64, "action log bounded by cap");
    }
}

#[derive(Serialize)]
pub struct AutomationStats {
    pub total_executions: i64,
    pub success: i64,
    pub failed: i64,
    pub partial: i64,
    pub skipped: i64,
    pub running: i64,
    pub avg_duration_ms: f64,
    pub success_rate: f64,
    pub last_execution: Option<String>,
}

// ── Tauri commands ────────────────────────────────────────────────────────────

// Manually fire an automation now (Manual Trigger, Phase 4). Runs synchronously
// on the command connection so the caller gets the resulting execution id.
#[tauri::command]
pub async fn run_automation_now(state: State<'_, AppState>, id: String) -> Result<String, String> {
    // Read the rule under the lock, then DROP it before running. Actions can sleep
    // (delay/wait, up to 10s each) — holding state.db across that would freeze every
    // other IPC command, including the SplitBrainVerifier's get_system_state poll.
    let id_clone = id.clone();
    let (title, ws, meta_s): (String, String, String) = {
        state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

        conn.query_row(
            "SELECT title, workspace_id, metadata FROM items \
             WHERE id = ? AND item_type = 'automation' AND deleted = 0",
            [&id_clone],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| format!("automation '{}' not found", id_clone))
    
        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)?
};
    let meta: Value = serde_json::from_str(&meta_s).unwrap_or_else(|_| json!({}));
    let auto = Automation { id: id.clone(), title: title.clone(), meta };
    let ev = Event {
        name: "Manual".into(),
        workspace_id: ws.clone(),
        entity_id: None,
        entity_type: None,
        title: Some(title),
        metadata: json!({}),
    };

    // Run on a dedicated engine connection (WAL) so we never hold the command mutex.
    let mut conn = open_engine_conn(&state.db_path)?;
    let mutated = run_automation(&mut conn, &auto, &ev, "manual", 0);

    let exec_id: String = conn
        .query_row(
            "SELECT id FROM automation_executions WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1",
            [&id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    // Reconcile the frontend cache if the manual run changed data.
    if mutated {
        let _ = state.app_handle.emit(DATA_CHANGED_EVENT, &ws);
    }
    Ok(exec_id)
}

// Backend-originated event injection (e.g. ApplicationStarted from the frontend
// boot path, or command-palette manual events). Dispatched on the engine conn.
#[tauri::command]
pub async fn emit_event(
    state: State<'_, AppState>,
    name: String,
    workspace_id: String,
    entity_id: Option<String>,
    entity_type: Option<String>,
    title: Option<String>,
    metadata: Option<String>,
) -> Result<(), String> {
    let md: Value = metadata
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}));
    let ev = Event { name, workspace_id, entity_id, entity_type, title, metadata: md };
    emit(&state, vec![ev]);
    Ok(())
}

#[tauri::command]
pub async fn get_automation_executions(
    state: State<'_, AppState>,
    automation_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ExecutionRow>, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    let lim = limit.unwrap_or(100).clamp(1, 1000);
    let mut rows = Vec::new();
    let map = |r: &rusqlite::Row| -> rusqlite::Result<ExecutionRow> {
        Ok(ExecutionRow {
            id: r.get(0)?,
            automation_id: r.get(1)?,
            trigger_source: r.get(2)?,
            status: r.get(3)?,
            started_at: r.get(4)?,
            finished_at: r.get(5)?,
            duration_ms: r.get(6)?,
            actions_executed: r.get(7)?,
            last_completed_index: r.get(8)?,
            output: r.get(9)?,
            error: r.get(10)?,
        })
    };
    let cols = "id, automation_id, trigger_source, status, started_at, finished_at, duration_ms, actions_executed, last_completed_index, output, error";
    match automation_id {
        Some(aid) => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {} FROM automation_executions WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?",
                    cols
                ))
                .map_err(|e| e.to_string())?;
            let it = stmt.query_map(rusqlite::params![aid, lim], map).map_err(|e| e.to_string())?;
            for r in it { rows.push(r.map_err(|e| e.to_string())?); }
        }
        None => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {} FROM automation_executions ORDER BY started_at DESC LIMIT ?",
                    cols
                ))
                .map_err(|e| e.to_string())?;
            let it = stmt.query_map([lim], map).map_err(|e| e.to_string())?;
            for r in it { rows.push(r.map_err(|e| e.to_string())?); }
        }
    }
    Ok(rows)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn get_automation_stats(
    state: State<'_, AppState>,
    automation_id: Option<String>,
) -> Result<AutomationStats, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    let (where_clause, has_filter) = match &automation_id {
        Some(_) => (" WHERE automation_id = ?1", true),
        None => ("", false),
    };
    let count_of = |status: &str| -> i64 {
        let q = format!(
            "SELECT COUNT(*) FROM automation_executions{}{}status = '{}'",
            where_clause,
            if has_filter { " AND " } else { " WHERE " },
            status
        );
        if has_filter {
            conn.query_row(&q, [automation_id.as_ref().unwrap()], |r| r.get(0)).unwrap_or(0)
        } else {
            conn.query_row(&q, [], |r| r.get(0)).unwrap_or(0)
        }
    };
    let total: i64 = {
        let q = format!("SELECT COUNT(*) FROM automation_executions{}", where_clause);
        if has_filter {
            conn.query_row(&q, [automation_id.as_ref().unwrap()], |r| r.get(0)).unwrap_or(0)
        } else {
            conn.query_row(&q, [], |r| r.get(0)).unwrap_or(0)
        }
    };
    let avg: f64 = {
        let q = format!(
            "SELECT COALESCE(AVG(duration_ms),0) FROM automation_executions{}{}duration_ms IS NOT NULL",
            where_clause,
            if has_filter { " AND " } else { " WHERE " }
        );
        if has_filter {
            conn.query_row(&q, [automation_id.as_ref().unwrap()], |r| r.get(0)).unwrap_or(0.0)
        } else {
            conn.query_row(&q, [], |r| r.get(0)).unwrap_or(0.0)
        }
    };
    let last: Option<String> = {
        let q = format!("SELECT started_at FROM automation_executions{} ORDER BY started_at DESC LIMIT 1", where_clause);
        if has_filter {
            conn.query_row(&q, [automation_id.as_ref().unwrap()], |r| r.get(0)).ok()
        } else {
            conn.query_row(&q, [], |r| r.get(0)).ok()
        }
    };
    let success = count_of("SUCCESS");
    let failed = count_of("FAILED");
    let partial = count_of("PARTIAL");
    let skipped = count_of("SKIPPED");
    let running = count_of("RUNNING");
    // A PARTIAL run is a completed non-success outcome, so it counts against the
    // success rate (excluding it would inflate the rate).
    let finished = success + failed + partial;
    let success_rate = if finished > 0 { success as f64 / finished as f64 } else { 0.0 };
    Ok(AutomationStats {
        total_executions: total,
        success,
        failed,
        partial,
        skipped,
        running,
        avg_duration_ms: avg,
        success_rate,
        last_execution: last,
    })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}
