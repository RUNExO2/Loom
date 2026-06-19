use crate::AppState;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct DashboardWidget {
    pub id: String,
    pub workspace_id: String,
    pub widget_type: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub hidden: bool,
    #[serde(default)]
    pub config: Option<String>,
}

#[tauri::command]
pub async fn get_dashboard_layout(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<DashboardWidget>, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {


    let mut stmt = conn
        .prepare("SELECT id, workspace_id, widget_type, x, y, w, h, hidden, config FROM dashboard_widgets WHERE workspace_id = ?")
        .map_err(|e| e.to_string())?;

    let iter = stmt
        .query_map(params![workspace_id], |row| {
            Ok(DashboardWidget {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                widget_type: row.get(2)?,
                x: row.get(3)?,
                y: row.get(4)?,
                w: row.get(5)?,
                h: row.get(6)?,
                hidden: row.get(7)?,
                config: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut widgets = Vec::new();
    for w in iter {
        widgets.push(w.map_err(|e| e.to_string())?);
    }

    Ok(widgets)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn save_dashboard_layout(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    widgets: Vec<DashboardWidget>,
) -> Result<(), String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // Clear existing widgets for this workspace to fully replace the layout
    tx.execute(
        "DELETE FROM dashboard_widgets WHERE workspace_id = ?",
        params![workspace_id],
    )
    .map_err(|e| e.to_string())?;

    // Insert new layout
    for w in widgets {
        tx.execute(
            "INSERT INTO dashboard_widgets (id, workspace_id, widget_type, x, y, w, h, hidden, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![w.id, workspace_id, w.widget_type, w.x, w.y, w.w, w.h, w.hidden, w.config],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(())

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}
