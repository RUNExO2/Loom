use serde::Serialize;
use tauri::State;
use crate::AppState;
use crate::commands::get_active_items;
use serde_json::Value;
use chrono::{DateTime, TimeZone, Utc, Local, Datelike, Timelike};

// ---- Timeline ----
#[derive(Serialize)]
pub struct TimelineEvent {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub sub: String,
    pub icon: String,
    pub color: String,
    pub ts: i64,
    pub when: String,
    pub month: String,
}

fn parse_created_at(s: &str) -> Option<DateTime<Local>> {
    let s_clean = s.replace(" ", "T");
    let mut dt_str = s_clean.clone();
    if !dt_str.ends_with('Z') {
        dt_str.push('Z');
    }
    if let Ok(dt) = dt_str.parse::<DateTime<Utc>>() {
        Some(dt.with_timezone(&Local))
    } else {
        None
    }
}

#[tauri::command]
pub async fn get_timeline(state: State<'_, AppState>, workspace_id: String) -> Result<Vec<TimelineEvent>, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    // Projections aggregate over the whole workspace, so pass the unbounded sentinel
    // limit (matches get_items default) rather than a paginated slice.
    let items = get_active_items(&conn, &workspace_id, 1_000_000, 0)?;
    let now = Local::now();

    let mut events = Vec::new();
    for it in items {
        let meta: Value = serde_json::from_str(&it.metadata).unwrap_or(serde_json::json!({}));
        let mut icon = meta.get("icon").and_then(|v| v.as_str()).unwrap_or("ph-circle").to_string();
        let mut color = meta.get("color").and_then(|v| v.as_str()).unwrap_or("var(--text-faint)").to_string();
        let sub: String;

        match it.item_type.as_str() {
            "task" => {
                if icon == "ph-circle" { icon = "ph-check-square".to_string(); }
                if color == "var(--text-faint)" { color = "var(--h-tasks)".to_string(); }
                let done = meta.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
                let due = meta.get("due").and_then(|v| v.as_str()).unwrap_or("Today");
                sub = if done { "Completed".to_string() } else { format!("Open · {}", due) };
            }
            "library" => {
                if icon == "ph-circle" { icon = "ph-stack".to_string(); }
                if color == "var(--text-faint)" { color = "var(--h-library)".to_string(); }
                let prog = meta.get("progress").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let status = meta.get("status").and_then(|v| v.as_str()).unwrap_or("Reading");
                sub = format!("{}% · {}", prog, status);
            }
            "project" => {
                if icon == "ph-circle" { icon = "ph-kanban".to_string(); }
                if color == "var(--text-faint)" { color = "var(--h-projects)".to_string(); }
                let prog = meta.get("progress").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let status = meta.get("status").and_then(|v| v.as_str()).unwrap_or("Active");
                sub = format!("{} · {}%", status, prog);
            }
            "habit" => {
                if icon == "ph-circle" { icon = "ph-pulse".to_string(); }
                if color == "var(--text-faint)" { color = "var(--h-habits)".to_string(); }
                let streak = meta.get("streak").and_then(|v| v.as_f64()).unwrap_or(0.0);
                sub = format!("{}-day streak", streak);
            }
            "note" => {
                if icon == "ph-circle" { icon = "ph-note".to_string(); }
                if color == "var(--text-faint)" { color = "var(--h-notes)".to_string(); }
                sub = meta.get("folder").and_then(|v| v.as_str()).unwrap_or("Note").to_string();
            }
            "calendar" => {
                if icon == "ph-circle" { icon = "ph-calendar-dots".to_string(); }
                if color == "var(--text-faint)" { color = "var(--h-calendar)".to_string(); }
                sub = meta.get("sub").and_then(|v| v.as_str()).unwrap_or("Event").to_string();
            }
            "file" => {
                if icon == "ph-circle" { icon = "ph-file".to_string(); }
                if color == "var(--text-faint)" { color = "var(--h-files)".to_string(); }
                sub = "File".to_string();
            }
            "bookmark" => {
                if icon == "ph-circle" { icon = "ph-bookmark-simple".to_string(); }
                if color == "var(--text-faint)" { color = "var(--h-bookmarks)".to_string(); }
                sub = meta.get("url").and_then(|v| v.as_str()).unwrap_or("Bookmark").to_string();
            }
            _ => {
                sub = it.item_type.clone();
            }
        }

        let dt = parse_created_at(&it.created_at).unwrap_or(now);
        let same_day = dt.year() == now.year() && dt.month() == now.month() && dt.day() == now.day();
        let hh = format!("{:02}:{:02}", dt.hour(), dt.minute());
        
        let months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        let short = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        let month_idx = dt.month0() as usize;

        let when = if same_day {
            format!("Today · {}", hh)
        } else {
            format!("{} {}", short[month_idx], dt.day())
        };

        let month_str = format!("{} {}", months[month_idx], dt.year());

        events.push(TimelineEvent {
            id: it.id,
            kind: it.item_type,
            title: it.title,
            sub,
            icon,
            color,
            ts: dt.timestamp_millis(),
            when,
            month: month_str,
        });
    }

    events.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(events)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// ---- Activity feed (unified change timeline) ----
// A workspace-wide stream of what changed and when, across every item type. Sourced
// honestly from SQLite: creations come from items.created_at; deletions come from the
// mutation_ledger (the only place a delete is timestamped). Updates are intentionally
// excluded — the schema doesn't timestamp them, and a faked time would be a lie.
#[derive(Serialize)]
pub struct ActivityEntry {
    pub id: String,
    pub action: String, // "created" | "deleted"
    pub item_id: String,
    pub kind: String,   // item_type
    pub title: String,
    pub icon: String,
    pub color: String,
    pub ts: i64,
    pub when: String,
}

fn type_visual(item_type: &str) -> (&'static str, &'static str) {
    match item_type {
        "task" => ("ph-check-square", "var(--h-tasks)"),
        "note" => ("ph-note", "var(--h-notes)"),
        "project" => ("ph-kanban", "var(--h-projects)"),
        "habit" => ("ph-pulse", "var(--h-habits)"),
        "library" => ("ph-stack", "var(--h-library)"),
        "file" => ("ph-file", "var(--h-files)"),
        "bookmark" => ("ph-bookmark-simple", "var(--h-bookmarks)"),
        "calendar" => ("ph-calendar-dots", "var(--h-calendar)"),
        "automation" => ("ph-lightning", "var(--h-automation)"),
        _ => ("ph-circle", "var(--text-faint)"),
    }
}

fn when_label(dt: DateTime<Local>, now: DateTime<Local>) -> String {
    let same_day = dt.year() == now.year() && dt.month() == now.month() && dt.day() == now.day();
    let short = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if same_day {
        format!("Today · {:02}:{:02}", dt.hour(), dt.minute())
    } else {
        format!("{} {}", short[dt.month0() as usize], dt.day())
    }
}

#[tauri::command]
pub async fn get_activity_feed(
    state: State<'_, AppState>,
    workspace_id: String,
    limit: Option<u32>,
) -> Result<Vec<ActivityEntry>, String> {
    let cap = limit.unwrap_or(100) as usize;
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {
            let now = Local::now();
            let mut entries: Vec<ActivityEntry> = Vec::new();

            // Creations — every item in the workspace, deleted or not.
            let mut stmt = conn.prepare(
                "SELECT id, item_type, title, created_at FROM items WHERE workspace_id = ?1",
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([&workspace_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
            }).map_err(|e| e.to_string())?;
            for row in rows {
                let (id, kind, title, created) = row.map_err(|e| e.to_string())?;
                let dt = parse_created_at(&created).unwrap_or(now);
                let (icon, color) = type_visual(&kind);
                entries.push(ActivityEntry {
                    id: format!("c:{}", id),
                    action: "created".into(),
                    item_id: id, kind, title,
                    icon: icon.into(), color: color.into(),
                    ts: dt.timestamp_millis(),
                    when: when_label(dt, now),
                });
            }

            // Deletions — recovered from the mutation ledger, joined back to the item
            // (still present as a soft-deleted row) for its type/title, scoped to ws.
            let mut dstmt = conn.prepare(
                "SELECT ml.payload, ml.created_at FROM mutation_ledger ml \
                 WHERE ml.status = 'COMMITTED' \
                   AND ml.command_type IN ('delete_item','automation_delete') \
                 ORDER BY ml.created_at DESC LIMIT 500",
            ).map_err(|e| e.to_string())?;
            let drows = dstmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            }).map_err(|e| e.to_string())?;
            for row in drows {
                let (payload, created) = row.map_err(|e| e.to_string())?;
                let pid = serde_json::from_str::<Value>(&payload)
                    .ok()
                    .and_then(|v| v.get("id").and_then(|x| x.as_str()).map(String::from));
                let pid = match pid { Some(p) => p, None => continue };
                let found: Option<(String, String, String)> = conn.query_row(
                    "SELECT item_type, title, workspace_id FROM items WHERE id = ?1",
                    [&pid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                ).ok();
                if let Some((kind, title, ws)) = found {
                    if ws != workspace_id { continue; }
                    let dt = parse_created_at(&created).unwrap_or(now);
                    let (icon, color) = type_visual(&kind);
                    entries.push(ActivityEntry {
                        id: format!("d:{}:{}", pid, created),
                        action: "deleted".into(),
                        item_id: pid, kind, title,
                        icon: icon.into(), color: color.into(),
                        ts: dt.timestamp_millis(),
                        when: when_label(dt, now),
                    });
                }
            }

            entries.sort_by(|a, b| b.ts.cmp(&a.ts));
            entries.truncate(cap);
            Ok(entries)
        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// ---- Stats ----
#[derive(Serialize)]
pub struct StatCard {
    pub label: String,
    pub value: usize,
    pub icon: String,
    pub color: String,
}

#[derive(Serialize)]
#[allow(non_snake_case)] // field names are the camelCase JSON contract the frontend reads
pub struct StatsCounts {
    pub activeTasks: usize,
    pub completedTasks: usize,
    pub projects: usize,
    pub habits: usize,
    pub notes: usize,
    pub bookmarks: usize,
    pub files: usize,
    pub library: usize,
    pub calendar: usize,
    pub total: usize,
}

#[derive(Serialize)]
#[allow(non_snake_case)] // field names are the camelCase JSON contract the frontend reads
pub struct StatsProjection {
    pub counts: StatsCounts,
    pub cards: Vec<StatCard>,
    pub series: Vec<usize>,
    pub seriesDays: Vec<String>,
    pub seriesMax: usize,
    pub hasSeries: bool,
}

#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>, workspace_id: String) -> Result<StatsProjection, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    // Stats count the entire workspace; unbounded sentinel limit, no pagination.
    let items = get_active_items(&conn, &workspace_id, 1_000_000, 0)?;

    let mut completed_tasks = 0;
    let mut active_tasks = 0;
    let mut projects = 0;
    let mut habits = 0;
    let mut notes = 0;
    let mut bookmarks = 0;
    let mut files = 0;
    let mut library = 0;
    let mut calendar = 0;

    for it in &items {
        match it.item_type.as_str() {
            "task" => {
                let meta: Value = serde_json::from_str(&it.metadata).unwrap_or(serde_json::json!({}));
                if meta.get("done").and_then(|v| v.as_bool()).unwrap_or(false) {
                    completed_tasks += 1;
                } else {
                    active_tasks += 1;
                }
            }
            "project" => projects += 1,
            "habit" => habits += 1,
            "note" => notes += 1,
            "bookmark" => bookmarks += 1,
            "file" => files += 1,
            "library" => library += 1,
            "calendar" => calendar += 1,
            _ => {}
        }
    }

    let cards = vec![
        StatCard { label: "active tasks".into(), value: active_tasks, icon: "ph-check-circle".into(), color: "var(--h-tasks)".into() },
        StatCard { label: "completed".into(), value: completed_tasks, icon: "ph-check-square".into(), color: "var(--h-habits)".into() },
        StatCard { label: "projects".into(), value: projects, icon: "ph-kanban".into(), color: "var(--h-projects)".into() },
        StatCard { label: "habits".into(), value: habits, icon: "ph-pulse".into(), color: "var(--h-habits)".into() },
        StatCard { label: "notes".into(), value: notes, icon: "ph-note".into(), color: "var(--h-notes)".into() },
        StatCard { label: "library".into(), value: library, icon: "ph-stack".into(), color: "var(--h-library)".into() },
        StatCard { label: "files".into(), value: files, icon: "ph-file".into(), color: "var(--h-files)".into() },
        StatCard { label: "bookmarks".into(), value: bookmarks, icon: "ph-bookmark-simple".into(), color: "var(--h-bookmarks)".into() },
    ];

    let mut series = vec![0; 7];
    let mut series_days = Vec::new();
    let now = Local::now();
    let start_of_today = Local.with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0).single().unwrap_or(now);
    
    let day_names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for i in 0..7 {
        let d = start_of_today - chrono::Duration::days(6 - i);
        series_days.push(day_names[d.weekday().num_days_from_sunday() as usize].to_string());
    }

    for it in &items {
        if let Some(d) = parse_created_at(&it.created_at) {
            let day_start = Local.with_ymd_and_hms(d.year(), d.month(), d.day(), 0, 0, 0).single().unwrap_or(d);
            let diff_days = (start_of_today.timestamp() - day_start.timestamp()) / 86400;
            if diff_days >= 0 && diff_days <= 6 {
                series[6 - diff_days as usize] += 1;
            }
        }
    }

    let series_max = *series.iter().max().unwrap_or(&0);

    Ok(StatsProjection {
        counts: StatsCounts {
            activeTasks: active_tasks,
            completedTasks: completed_tasks,
            projects,
            habits,
            notes,
            bookmarks,
            files,
            library,
            calendar,
            total: items.len(),
        },
        cards,
        series,
        seriesDays: series_days,
        seriesMax: series_max,
        hasSeries: series_max > 0,
    })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}
