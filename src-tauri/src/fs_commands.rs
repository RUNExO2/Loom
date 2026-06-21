use crate::AppState;
use crate::commands::execute_two_phase;
use crate::commands::create_link_impl;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{Manager, State};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileEntry {
    pub id: String,
    pub workspace_id: String,
    pub item_type: String,
    pub title: String,
    pub path: String,
    pub filename: String,
    pub extension: Option<String>,
    pub mime_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub modified_at: Option<u64>,
    pub favorite: bool,
    pub tags: Option<String>,
}

fn get_loom_files_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let files_dir = app_data_dir.join("Files");
    if !files_dir.exists() {
        fs::create_dir_all(&files_dir).map_err(|e| e.to_string())?;
    }
    Ok(files_dir)
}

fn get_loom_notes_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let notes_dir = app_data_dir.join("Notes");
    if !notes_dir.exists() {
        fs::create_dir_all(&notes_dir).map_err(|e| e.to_string())?;
    }
    Ok(notes_dir)
}

pub fn get_trash_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let trash_dir = app_data_dir.join(".trash");
    if !trash_dir.exists() {
        fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;
    }
    Ok(trash_dir)
}

pub fn move_file_to_trash(app_handle: &tauri::AppHandle, id: &str, original_path: &str) -> Result<(), String> {
    let trash_dir = get_trash_dir(app_handle)?;
    let src_path = Path::new(original_path);
    if src_path.exists() && src_path.is_file() {
        let trash_file_path = trash_dir.join(id);
        fs::rename(src_path, trash_file_path).map_err(|e| format!("Failed to move file to trash: {}", e))?;
    }
    Ok(())
}

pub fn restore_file_from_trash(app_handle: &tauri::AppHandle, id: &str, original_path: &str) -> Result<(), String> {
    let trash_dir = get_trash_dir(app_handle)?;
    let trash_file_path = trash_dir.join(id);
    if trash_file_path.exists() && trash_file_path.is_file() {
        let dest_path = Path::new(original_path);
        if let Some(parent) = dest_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
            }
        }
        fs::rename(trash_file_path, dest_path).map_err(|e| format!("Failed to restore file from trash: {}", e))?;
    }
    Ok(())
}

fn extract_metadata(path: &Path) -> (Option<u64>, Option<u64>) {
    if let Ok(metadata) = fs::metadata(path) {
        let size = Some(metadata.len());
        let modified = metadata
            .modified()
            .ok()
            .and_then(|sys_time| sys_time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|dur| dur.as_secs());
        (size, modified)
    } else {
        (None, None)
    }
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect()
}

fn generate_unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("")).to_path_buf();
    let file_stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let extension = path.extension().unwrap_or_default().to_string_lossy().to_string();
    
    let mut counter = 1;
    loop {
        let new_filename = if extension.is_empty() {
            format!("{} ({})", file_stem, counter)
        } else {
            format!("{} ({}).{}", file_stem, counter, extension)
        };
        let new_path = parent.join(new_filename);
        if !new_path.exists() {
            return new_path;
        }
        counter += 1;
    }
}

fn guess_mime_type(ext: &str) -> String {
    match ext.to_lowercase().as_str() {
        "html" | "htm" => "text/html".to_string(),
        "txt" => "text/plain".to_string(),
        "md" | "markdown" => "text/markdown".to_string(),
        "pdf" => "application/pdf".to_string(),
        "png" => "image/png".to_string(),
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "gif" => "image/gif".to_string(),
        "css" => "text/css".to_string(),
        "js" => "application/javascript".to_string(),
        "json" => "application/json".to_string(),
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string(),
        "rtf" => "application/rtf".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn escape_html(text: &str) -> String {
    let mut s = String::new();
    for c in text.chars() {
        match c {
            '<' => s.push_str("&lt;"),
            '>' => s.push_str("&gt;"),
            '&' => s.push_str("&amp;"),
            '"' => s.push_str("&quot;"),
            '\'' => s.push_str("&apos;"),
            other => s.push(other),
        }
    }
    s
}

fn markdown_to_html(md: &str) -> String {
    let mut html = String::new();
    for line in md.lines() {
        let line = line.trim();
        if line.is_empty() {
            html.push_str("<p></p>");
            continue;
        }

        if line.starts_with("### ") {
            html.push_str(&format!("<h3>{}</h3>", escape_html(&line[4..])));
        } else if line.starts_with("## ") {
            html.push_str(&format!("<h2>{}</h2>", escape_html(&line[3..])));
        } else if line.starts_with("# ") {
            html.push_str(&format!("<h1>{}</h1>", escape_html(&line[2..])));
        } else if line.starts_with("> ") {
            html.push_str(&format!("<blockquote>{}</blockquote>", escape_html(&line[2..])));
        } else if line.starts_with("- ") {
            html.push_str(&format!("<ul><li>{}</li></ul>", escape_html(&line[2..])));
        } else if line.starts_with("* ") {
            html.push_str(&format!("<ul><li>{}</li></ul>", escape_html(&line[2..])));
        } else {
            let mut formatted = escape_html(line);
            while let Some(start) = formatted.find("**") {
                if let Some(end) = formatted[start + 2..].find("**") {
                    let text = &formatted[start + 2..start + 2 + end];
                    formatted = format!("{}<b>{}</b>{}", &formatted[..start], text, &formatted[start + 2 + end + 2..]);
                } else {
                    break;
                }
            }
            while let Some(start) = formatted.find('*') {
                if let Some(end) = formatted[start + 1..].find('*') {
                    let text = &formatted[start + 1..start + 1 + end];
                    formatted = format!("{}<i>{}</i>{}", &formatted[..start], text, &formatted[start + 1 + end + 1..]);
                } else {
                    break;
                }
            }
            html.push_str(&format!("<p>{}</p>", formatted));
        }
    }
    html.replace("</ul><ul>", "").replace("</ol><ol>", "")
}

fn rtf_to_html(rtf: &str) -> String {
    let mut plain_text = String::new();
    let mut i = 0;
    let chars: Vec<char> = rtf.chars().collect();
    while i < chars.len() {
        if chars[i] == '\\' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_alphabetic() {
                j += 1;
            }
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            if j < chars.len() && chars[j] == ' ' {
                j += 1;
            }
            i = j;
        } else if chars[i] == '{' || chars[i] == '}' {
            i += 1;
        } else {
            plain_text.push(chars[i]);
            i += 1;
        }
    }
    plain_text.lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| format!("<p>{}</p>", escape_html(line)))
        .collect::<Vec<String>>()
        .join("")
}

fn extract_docx_text(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut doc_file = archive.by_name("word/document.xml").map_err(|e| e.to_string())?;
    let mut xml_content = String::new();
    std::io::Read::read_to_string(&mut doc_file, &mut xml_content).map_err(|e| e.to_string())?;

    let mut text = String::new();
    let mut i = 0;
    let chars: Vec<char> = xml_content.chars().collect();
    while i < chars.len() {
        if chars[i] == '<' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '>' {
                j += 1;
            }
            if j < chars.len() {
                let tag: String = chars[i+1..j].iter().collect();
                if tag.starts_with("w:p") || tag == "/w:p" || tag == "w:br" {
                    text.push('\n');
                }
                i = j + 1;
            } else {
                i += 1;
            }
        } else {
            text.push(chars[i]);
            i += 1;
        }
    }
    Ok(text)
}

pub(crate) fn create_file_entry_impl(
    conn: &rusqlite::Connection,
    workspace_id: String,
    title: String,
    path: String,
    filename: String,
    extension: Option<String>,
    mime_type: Option<String>,
    size_bytes: Option<u64>,
    modified_at: Option<u64>,
) -> Result<FileEntry, String> {
    let id = conn
        .query_row(
            "INSERT INTO items (id, workspace_id, title, item_type, metadata) VALUES (lower(hex(randomblob(16))), ?, ?, 'file', '{}') RETURNING id",
            [workspace_id.clone(), title.clone()],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO files (id, path, filename, extension, mime_type, size_bytes, created_at, modified_at, favorite, tags) 
         VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'), ?, 0, '')",
        rusqlite::params![id.clone(), path, filename, extension, mime_type, size_bytes, modified_at],
    )
    .map_err(|e| e.to_string())?;

    Ok(FileEntry {
        id,
        workspace_id,
        item_type: "file".into(),
        title,
        path,
        filename,
        extension,
        mime_type,
        size_bytes,
        modified_at,
        favorite: false,
        tags: Some("".into()),
    })
}

#[tauri::command]
pub async fn fs_create_file(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    workspace_id: String,
    title: String,
    extension: Option<String>,
    folder: String,
) -> Result<FileEntry, String> {
    let files_dir = get_loom_files_dir(&app_handle)?;
    let mut target_dir = files_dir.clone();
    
    if folder != "Unfiled" && !folder.is_empty() {
        let safe_folder = sanitize_filename(&folder);
        target_dir = files_dir.join(safe_folder);
        if !target_dir.exists() {
            fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
        }
    }

    let ext_str = extension.as_deref().unwrap_or("txt").to_lowercase();
    let sanitized_title = sanitize_filename(&title);
    
    let filename = if sanitized_title.to_lowercase().ends_with(&format!(".{}", ext_str)) {
        sanitized_title.clone()
    } else {
        format!("{}.{}", sanitized_title, ext_str)
    };

    let target_path = target_dir.join(&filename);
    let unique_path = generate_unique_path(target_path);
    let final_filename = unique_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let final_title = unique_path.file_stem().unwrap_or_default().to_string_lossy().to_string();

    fs::write(&unique_path, b"").map_err(|e| e.to_string())?;
    
    let path_str = unique_path.to_string_lossy().to_string();
    let (size, modified) = extract_metadata(&unique_path);
    let mime = Some(guess_mime_type(&ext_str));

    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let payload = format!(r#"{{"workspace_id":"{}","title":"{}","action":"create_file"}}"#, workspace_id, final_title);
    
    let result = execute_two_phase(&mut conn, "create_file", &payload, |tx| {
        create_file_entry_impl(tx, workspace_id.clone(), final_title.clone(), path_str.clone(), final_filename.clone(), Some(ext_str.clone()), mime.clone(), size, modified)
    });

    if result.is_err() {
        let _ = fs::remove_file(&unique_path);
    }
    result

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn fs_import_file(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    workspace_id: String,
    source_path: String,
    strategy: String,
) -> Result<FileEntry, String> {
    let src = Path::new(&source_path);
    if !src.exists() || !src.is_file() {
        return Err("Invalid source path or file does not exist.".into());
    }

    let filename = src.file_name().unwrap_or_default().to_string_lossy().to_string();
    let extension = src.extension().map(|s| s.to_string_lossy().to_string().to_lowercase());
    let title = src.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext_str = extension.clone().unwrap_or_default();
    let mime = Some(guess_mime_type(&ext_str));

    let final_path;
    let mut was_copied = false;
    if strategy == "copy" {
        let files_dir = get_loom_files_dir(&app_handle)?;
        let dest = files_dir.join(&filename);
        let unique_dest = generate_unique_path(dest);
        fs::copy(src, &unique_dest).map_err(|e| format!("Failed to copy file: {}", e))?;
        final_path = unique_dest.to_string_lossy().to_string();
        was_copied = true;
    } else {
        final_path = source_path.clone();
    }

    let (size, modified) = extract_metadata(Path::new(&final_path));

    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let payload = format!(r#"{{"workspace_id":"{}","title":"{}","action":"import_file"}}"#, workspace_id, title);
    
    let result = execute_two_phase(&mut conn, "import_file", &payload, |tx| {
        create_file_entry_impl(tx, workspace_id.clone(), title.clone(), final_path.clone(), filename.clone(), extension.clone(), mime.clone(), size, modified)
    });

    if result.is_err() && was_copied {
        let _ = fs::remove_file(Path::new(&final_path));
    }
    result

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn fs_open_file(path: String) -> Result<(), String> {
    opener::open(&path).map_err(|e| format!("Failed to open file: {}", e))
}

#[tauri::command]
pub async fn fs_reveal_in_explorer(path: String) -> Result<(), String> {
    let path = Path::new(&path);
    if let Some(parent) = path.parent() {
        opener::reveal(path).or_else(|_| opener::open(parent))
            .map_err(|e| format!("Failed to reveal in explorer: {}", e))
    } else {
        opener::open(path).map_err(|e| format!("Failed to open: {}", e))
    }
}

#[tauri::command]
pub async fn fs_delete_file(state: State<'_, AppState>, id: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let path_opt: Option<String> = conn.query_row("SELECT path FROM files WHERE id = ?", [&id], |r| r.get(0)).ok();

    // 1. Prepare Phase (Filesystem)
    let mut staged_file = false;
    if let Some(ref path) = path_opt {
        let files_dir = get_loom_files_dir(&app_handle)?;
        let notes_dir = get_loom_notes_dir(&app_handle)?;
        let path_buf = Path::new(path);
        if path_buf.starts_with(files_dir) || path_buf.starts_with(notes_dir) {
            move_file_to_trash(&app_handle, &id, path)?;
            staged_file = true;
            let filename = path_buf.file_name().unwrap_or_default().to_string_lossy().to_string();
            conn.execute(
                "INSERT OR REPLACE INTO trash_ledger (id, original_path, filename) VALUES (?1, ?2, ?3)",
                [&id, path, &filename],
            ).map_err(|e| format!("Failed to update staging ledger: {}", e))?;
        }
    }

    // 2. Commit Phase (Database)
    let payload = format!(r#"{{"id":"{}"}}"#, id);
    let res = execute_two_phase(&mut conn, "delete_file_fs", &payload, |tx| {
        let rows_changed = tx.execute("UPDATE items SET deleted = 1 WHERE id = ? AND deleted = 0", [&id]).map_err(|e| e.to_string())?;
        if rows_changed == 0 {
            return Err(format!("File '{}' not found or already deleted", id));
        }
        Ok(id.clone())
    });

    // 3. Compensation / Rollback
    match res {
        Ok(val) => Ok(val),
        Err(e) => {
            if staged_file {
                if let Some(ref path) = path_opt {
                    let _ = restore_file_from_trash(&app_handle, &id, path);
                }
                let _ = conn.execute("DELETE FROM trash_ledger WHERE id = ?", [&id]);
            }
            Err(e)
        }
    }

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn fs_get_files(state: State<'_, AppState>, workspace_id: String) -> Result<Vec<FileEntry>, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    let mut stmt = conn.prepare(
        "SELECT i.id, i.workspace_id, i.item_type, i.title, 
                f.path, f.filename, f.extension, f.mime_type, f.size_bytes, f.modified_at, f.favorite, f.tags
         FROM items i
         JOIN files f ON i.id = f.id
         WHERE i.workspace_id = ? AND i.deleted = 0"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([workspace_id], |row| {
        Ok(FileEntry {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            item_type: row.get(2)?,
            title: row.get(3)?,
            path: row.get(4)?,
            filename: row.get(5)?,
            extension: row.get(6)?,
            mime_type: row.get(7)?,
            size_bytes: row.get(8)?,
            modified_at: row.get(9)?,
            favorite: row.get::<_, i32>(10)? != 0,
            tags: row.get(11)?,
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

#[tauri::command]
pub async fn fs_rename_file(state: State<'_, AppState>, id: String, new_title: String) -> Result<FileEntry, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let path_str: String = conn.query_row("SELECT path FROM files WHERE id = ?", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let old_path = Path::new(&path_str);
    
    if !old_path.exists() {
        return Err("File does not exist on disk".into());
    }

    let sanitized_title = sanitize_filename(&new_title);
    let ext = old_path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    
    let new_filename = if ext.is_empty() {
        sanitized_title.clone()
    } else if sanitized_title.to_lowercase().ends_with(&format!(".{}", ext.to_lowercase())) {
        sanitized_title.clone()
    } else {
        format!("{}.{}", sanitized_title, ext)
    };
    
    let new_path = old_path.with_file_name(&new_filename);
    let unique_path = generate_unique_path(new_path);
    let final_filename = unique_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let final_title = unique_path.file_stem().unwrap_or_default().to_string_lossy().to_string();

    let new_path_str = unique_path.to_string_lossy().to_string();
    // Record intent before the disk move so a crash before DB commit is recoverable.
    let op_id = record_pending_fs_op(&conn, &id, &path_str, &new_path_str, "rename")?;
    if let Err(e) = fs::rename(&old_path, &unique_path) {
        clear_pending_fs_op(&conn, &op_id);
        return Err(format!("Failed to rename file: {}", e));
    }

    let payload = format!(r#"{{"id":"{}","new_title":"{}"}}"#, id, final_title);
    let result = execute_two_phase(&mut conn, "rename_file", &payload, |tx| {
        tx.execute("UPDATE items SET title = ? WHERE id = ?", [&final_title, &id]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE files SET filename = ?, path = ? WHERE id = ?", [&final_filename, &new_path_str, &id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM pending_fs_ops WHERE id = ?", [&op_id]).map_err(|e| e.to_string())?;
        Ok(())
    });

    if result.is_err() {
        let _ = fs::rename(&unique_path, &old_path);
        clear_pending_fs_op(&conn, &op_id);
        return Err("Database rename registration failed.".into());
    }

    let mut stmt = conn.prepare(
        "SELECT i.id, i.workspace_id, i.item_type, i.title, 
                f.path, f.filename, f.extension, f.mime_type, f.size_bytes, f.modified_at, f.favorite, f.tags
         FROM items i
         JOIN files f ON i.id = f.id
         WHERE i.id = ?"
    ).map_err(|e| e.to_string())?;

    stmt.query_row([id], |row| {
        Ok(FileEntry {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            item_type: row.get(2)?,
            title: row.get(3)?,
            path: row.get(4)?,
            filename: row.get(5)?,
            extension: row.get(6)?,
            mime_type: row.get(7)?,
            size_bytes: row.get(8)?,
            modified_at: row.get(9)?,
            favorite: row.get::<_, i32>(10)? != 0,
            tags: row.get(11)?,
        })
    }).map_err(|e| e.to_string())

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn fs_create_note(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    workspace_id: String,
    title: String,
) -> Result<FileEntry, String> {
    let notes_dir = get_loom_notes_dir(&app_handle)?;
    let sanitized_title = sanitize_filename(&title);
    let target_path = notes_dir.join(format!("{}.html", sanitized_title));
    let unique_path = generate_unique_path(target_path);
    let final_filename = unique_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let final_title = unique_path.file_stem().unwrap_or_default().to_string_lossy().to_string();

    let initial_content = format!("<h1>{}</h1><p></p>", final_title);
    fs::write(&unique_path, initial_content.as_bytes()).map_err(|e| e.to_string())?;

    let path_str = unique_path.to_string_lossy().to_string();
    let (size, modified) = extract_metadata(&unique_path);

    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let payload = format!(r#"{{"workspace_id":"{}","title":"{}","action":"create_note"}}"#, workspace_id, final_title);
    
    let result = execute_two_phase(&mut conn, "create_note", &payload, |tx| {
        let id = tx.query_row(
            "INSERT INTO items (id, workspace_id, title, item_type, metadata) VALUES (lower(hex(randomblob(16))), ?, ?, 'note', '{}') RETURNING id",
            [workspace_id.clone(), final_title.clone()],
            |row| row.get::<_, String>(0),
        ).map_err(|e| e.to_string())?;

        tx.execute(
            "INSERT INTO files (id, path, filename, extension, mime_type, size_bytes, created_at, modified_at, favorite, tags) 
             VALUES (?, ?, ?, 'html', 'text/html', ?, strftime('%s','now'), ?, 0, '')",
            rusqlite::params![id.clone(), path_str.clone(), final_filename.clone(), size, modified],
        ).map_err(|e| e.to_string())?;

        Ok(FileEntry {
            id,
            workspace_id: workspace_id.clone(),
            item_type: "note".into(),
            title: final_title.clone(),
            path: path_str.clone(),
            filename: final_filename.clone(),
            extension: Some("html".into()),
            mime_type: Some("text/html".into()),
            size_bytes: size,
            modified_at: modified,
            favorite: false,
            tags: Some("".into()),
        })
    });

    if result.is_err() {
        let _ = fs::remove_file(&unique_path);
    }
    result

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn fs_read_note_content(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Note file does not exist on disk".into());
    }
    fs::read_to_string(p).map_err(|e| format!("Failed to read note file: {}", e))
}

#[tauri::command]
pub async fn fs_write_note_content(
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> Result<(), String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let path_str: String = conn.query_row("SELECT path FROM files WHERE id = ?", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let p = Path::new(&path_str);
    
    fs::write(p, content.as_bytes()).map_err(|e| format!("Failed to write note: {}", e))?;

    let (size, modified) = extract_metadata(p);
    
    let payload = format!(r#"{{"id":"{}","action":"write_note_content"}}"#, id);
    execute_two_phase(&mut conn, "write_note_content", &payload, |tx| {
        tx.execute(
            "UPDATE files SET size_bytes = ?, modified_at = ? WHERE id = ?",
            rusqlite::params![size, modified, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// Convert one supported document into HTML note text. None => unsupported extension.
fn note_html_for(src: &Path, ext: &str) -> Option<Result<String, String>> {
    let html = match ext {
        "txt" => fs::read_to_string(src).map_err(|e| e.to_string()).map(|plain|
            plain.split('\n').map(|l| format!("<p>{}</p>", escape_html(l))).collect::<Vec<_>>().join("")),
        "md" | "markdown" => fs::read_to_string(src).map_err(|e| e.to_string()).map(|md| markdown_to_html(&md)),
        "rtf" => fs::read_to_string(src).map_err(|e| e.to_string()).map(|rtf| rtf_to_html(&rtf)),
        "html" | "htm" => fs::read_to_string(src).map_err(|e| e.to_string()),
        "docx" => extract_docx_text(src).map(|plain|
            plain.split('\n').map(|l| format!("<p>{}</p>", escape_html(l))).collect::<Vec<_>>().join("")),
        _ => return None,
    };
    Some(html)
}

// Import a single document as a note: writes the .html into the Notes dir and registers
// it in SQLite. Shared by the single-file command and the folder importer.
fn import_one_note(conn: &mut rusqlite::Connection, app_handle: &tauri::AppHandle, workspace_id: &str, source_path: &str) -> Result<FileEntry, String> {
    let src = Path::new(source_path);
    if !src.exists() || !src.is_file() {
        return Err("Invalid source path or file does not exist.".into());
    }
    let ext = src.extension().map(|s| s.to_string_lossy().to_string().to_lowercase()).unwrap_or_default();
    let title = src.file_stem().unwrap_or_default().to_string_lossy().to_string();

    let text_content = match note_html_for(src, &ext) {
        Some(r) => r?,
        None => return Err("Unsupported file format for notes. Supported: txt, md, rtf, docx, html".into()),
    };

    let notes_dir = get_loom_notes_dir(app_handle)?;
    let sanitized_title = sanitize_filename(&title);
    let target_path = notes_dir.join(format!("{}.html", sanitized_title));
    let unique_path = generate_unique_path(target_path);
    let final_filename = unique_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let final_title = unique_path.file_stem().unwrap_or_default().to_string_lossy().to_string();

    // For html sources keep as-is; otherwise prefix a title heading.
    let document_html = if ext == "html" || ext == "htm" {
        text_content
    } else {
        format!("<h1>{}</h1>{}", final_title, text_content)
    };
    fs::write(&unique_path, document_html.as_bytes()).map_err(|e| e.to_string())?;

    let path_str = unique_path.to_string_lossy().to_string();
    let (size, modified) = extract_metadata(&unique_path);
    let payload = format!(r#"{{"workspace_id":"{}","title":"{}","action":"import_note"}}"#, workspace_id, final_title);

    let result = execute_two_phase(&mut *conn, "import_note", &payload, |tx| {
        let id = tx.query_row(
            "INSERT INTO items (id, workspace_id, title, item_type, metadata) VALUES (lower(hex(randomblob(16))), ?, ?, 'note', '{}') RETURNING id",
            [workspace_id, &final_title],
            |row| row.get::<_, String>(0),
        ).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO files (id, path, filename, extension, mime_type, size_bytes, created_at, modified_at, favorite, tags)
             VALUES (?, ?, ?, 'html', 'text/html', ?, strftime('%s','now'), ?, 0, '')",
            rusqlite::params![id, path_str, final_filename, size, modified],
        ).map_err(|e| e.to_string())?;
        Ok(FileEntry {
            id, workspace_id: workspace_id.to_string(), item_type: "note".into(), title: final_title.clone(),
            path: path_str.clone(), filename: final_filename.clone(), extension: Some("html".into()),
            mime_type: Some("text/html".into()), size_bytes: size, modified_at: modified, favorite: false, tags: Some("".into()),
        })
    });
    if result.is_err() {
        let _ = fs::remove_file(&unique_path);
    }
    result
}

#[tauri::command]
pub async fn fs_import_note_file(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    workspace_id: String,
    source_path: String,
) -> Result<FileEntry, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    import_one_note(&mut conn, &app_handle, &workspace_id, &source_path)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ImportFolderResult { pub imported: u32, pub skipped: u32 }

fn collect_note_files(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 6 { return; }
    let entries = match fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Skip hidden/system dirs like Obsidian's .obsidian
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            collect_note_files(&path, depth + 1, out);
        } else if path.is_file() {
            let ext = path.extension().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            if ["md", "markdown", "txt", "html", "htm"].contains(&ext.as_str()) {
                out.push(path);
            }
        }
    }
}

// Import every supported note file under a folder (recursive) — used by the Obsidian /
// Notion importers in Settings. Real: each file becomes a persisted note.
#[tauri::command]
pub async fn import_notes_from_folder(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    workspace_id: String,
    folder: String,
) -> Result<ImportFolderResult, String> {
    let dir = Path::new(&folder);
    if !dir.exists() || !dir.is_dir() {
        return Err("That folder does not exist.".into());
    }
    let mut files = Vec::new();
    collect_note_files(dir, 0, &mut files);
    if files.is_empty() {
        return Err("No .md, .txt, or .html files found in that folder.".into());
    }
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let mut imported = 0u32;
    let mut skipped = 0u32;
    for f in files {
        match import_one_note(&mut conn, &app_handle, &workspace_id, &f.to_string_lossy()) {
            Ok(_) => imported += 1,
            Err(_) => skipped += 1,
        }
    }
    Ok(ImportFolderResult { imported, skipped })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// ─────────────────────────── Advanced Obsidian vault importer ───────────────────────────
// Handles the five things a plain markdown import drops: YAML frontmatter, #hashtags,
// [[wikilinks]] (as real graph edges), ![[embeds]]/attachments (copied + registered), and
// metadata extraction (tags/aliases/source persisted to item metadata).

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct ObsidianImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub links_created: u32,
    pub attachments: u32,
}

fn clean_scalar(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(s);
    let s = s.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')).unwrap_or(s);
    s.trim().trim_start_matches('#').trim().to_string()
}

// Parse a leading `--- ... ---` YAML frontmatter block. Minimal by design — covers the
// scalar / inline-list / dash-list shapes Obsidian actually emits. Returns (fields, body).
fn parse_frontmatter(content: &str) -> (HashMap<String, Vec<String>>, String) {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    let content = content.trim_start_matches('\u{feff}');
    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return (map, content.to_string());
    }
    let mut end = None;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if line.trim() == "---" { end = Some(i); break; }
    }
    let end = match end { Some(e) => e, None => return (map, content.to_string()) };

    let mut current_key: Option<String> = None;
    for &line in &lines[1..end] {
        let trimmed = line.trim_start();
        if let Some(item) = trimmed.strip_prefix("- ") {
            if let Some(k) = &current_key {
                let v = clean_scalar(item);
                if !v.is_empty() { map.entry(k.clone()).or_default().push(v); }
            }
            continue;
        }
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim().to_lowercase();
            let val = line[colon + 1..].trim();
            current_key = Some(key.clone());
            if val.is_empty() {
                map.entry(key).or_default();
            } else if val.starts_with('[') && val.ends_with(']') {
                let inner = &val[1..val.len() - 1];
                let vals: Vec<String> = inner.split(',').map(clean_scalar).filter(|s| !s.is_empty()).collect();
                map.insert(key, vals);
            } else if val.contains(',') {
                let vals: Vec<String> = val.split(',').map(clean_scalar).filter(|s| !s.is_empty()).collect();
                map.insert(key, vals);
            } else {
                map.insert(key, vec![clean_scalar(val)]);
            }
        }
    }
    let body = lines[end + 1..].join("\n");
    (map, body)
}

// Resolve a wikilink target to a lookup key: strip any #heading and |alias, take the
// basename, lowercase it. `[[Folder/Note#Sec|Label]]` -> "note".
fn wikilink_key(target: &str) -> String {
    let target = target.split('|').next().unwrap_or(target);
    let target = target.split('#').next().unwrap_or(target);
    let base = target.rsplit(['/', '\\']).next().unwrap_or(target);
    base.trim().to_lowercase()
}

// Markdown → HTML with Obsidian extensions. Text is HTML-escaped first; the special
// tokens ([[ ]], ![[ ]], [](), #tag, **, *, `) survive escaping and are then expanded to
// real HTML. Collects wikilink targets and embed filenames for the caller to wire up.
fn obsidian_md_to_html(
    body: &str,
    wikilinks: &mut Vec<String>,
    embeds: &mut Vec<String>,
) -> String {
    let wl = regex::Regex::new(r"\[\[([^\]]+)\]\]").unwrap();
    let embed = regex::Regex::new(r"!\[\[([^\]]+)\]\]").unwrap();
    let md_img = regex::Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)").unwrap();
    let md_link = regex::Regex::new(r"\[([^\]]+)\]\(([^)]+)\)").unwrap();
    let hashtag = regex::Regex::new(r"(^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)").unwrap();
    let bold = regex::Regex::new(r"\*\*([^*]+)\*\*").unwrap();
    let italic = regex::Regex::new(r"\*([^*]+)\*").unwrap();
    let code = regex::Regex::new(r"`([^`]+)`").unwrap();

    let inline = |line: &str, wikilinks: &mut Vec<String>, embeds: &mut Vec<String>| -> String {
        let mut s = escape_html(line);
        // Embeds first (![[...]]) so they aren't eaten by the wikilink rule.
        s = embed.replace_all(&s, |c: &regex::Captures| {
            let name = c[1].split('|').next().unwrap_or(&c[1]).trim().to_string();
            let idx = embeds.len();
            embeds.push(name.clone());
            format!("<a class=\"attachment-card\" data-attachment=\"__EMBED_{}__\"><i class=\"ph ph-paperclip\"></i> {}</a>", idx, escape_html(&name))
        }).to_string();
        // Markdown images -> attachment placeholder too (path-based).
        s = md_img.replace_all(&s, |c: &regex::Captures| {
            let idx = embeds.len();
            embeds.push(c[2].trim().to_string());
            let alt = if c[1].is_empty() { "image" } else { &c[1] };
            format!("<a class=\"attachment-card\" data-attachment=\"__EMBED_{}__\"><i class=\"ph ph-image\"></i> {}</a>", idx, alt)
        }).to_string();
        // Wikilinks -> internal anchor (resolved to a graph edge later).
        s = wl.replace_all(&s, |c: &regex::Captures| {
            let raw = c[1].to_string();
            let parts: Vec<&str> = raw.splitn(2, '|').collect();
            let target = parts[0].trim();
            let label = parts.get(1).map(|x| x.trim()).unwrap_or(target);
            wikilinks.push(target.to_string());
            format!("<a class=\"wikilink\" data-wikilink=\"{}\">{}</a>", escape_html(target), escape_html(label))
        }).to_string();
        // Standard markdown links.
        s = md_link.replace_all(&s, |c: &regex::Captures| {
            format!("<a href=\"{}\">{}</a>", escape_html(c[2].trim()), c[1].to_string())
        }).to_string();
        s = bold.replace_all(&s, "<b>$1</b>").to_string();
        s = italic.replace_all(&s, "<i>$1</i>").to_string();
        s = code.replace_all(&s, "<code>$1</code>").to_string();
        s = hashtag.replace_all(&s, "$1<span class=\"tag\">#$2</span>").to_string();
        s
    };

    let mut html = String::new();
    let mut in_code = false;
    for raw_line in body.lines() {
        let line = raw_line.trim_end();
        if line.trim_start().starts_with("```") {
            if in_code { html.push_str("</code></pre>"); in_code = false; }
            else { let lang = line.trim_start().trim_start_matches('`'); html.push_str(&format!("<pre><code class=\"language-{}\">", escape_html(lang.trim()))); in_code = true; }
            continue;
        }
        if in_code { html.push_str(&escape_html(raw_line)); html.push('\n'); continue; }

        let t = line.trim();
        if t.is_empty() { html.push_str("<p></p>"); continue; }
        if let Some(r) = t.strip_prefix("### ") { html.push_str(&format!("<h3>{}</h3>", inline(r, wikilinks, embeds))); }
        else if let Some(r) = t.strip_prefix("## ") { html.push_str(&format!("<h2>{}</h2>", inline(r, wikilinks, embeds))); }
        else if let Some(r) = t.strip_prefix("# ") { html.push_str(&format!("<h1>{}</h1>", inline(r, wikilinks, embeds))); }
        else if let Some(r) = t.strip_prefix("> ") { html.push_str(&format!("<blockquote>{}</blockquote>", inline(r, wikilinks, embeds))); }
        else if let Some(r) = t.strip_prefix("- [ ] ").or_else(|| t.strip_prefix("* [ ] ")) {
            html.push_str(&format!("<ul data-type=\"taskList\"><li data-checked=\"false\"><label><input type=\"checkbox\"></label><div>{}</div></li></ul>", inline(r, wikilinks, embeds)));
        }
        else if let Some(r) = t.strip_prefix("- [x] ").or_else(|| t.strip_prefix("* [x] ")) {
            html.push_str(&format!("<ul data-type=\"taskList\"><li data-checked=\"true\"><label><input type=\"checkbox\" checked></label><div>{}</div></li></ul>", inline(r, wikilinks, embeds)));
        }
        else if let Some(r) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) { html.push_str(&format!("<ul><li>{}</li></ul>", inline(r, wikilinks, embeds))); }
        else { html.push_str(&format!("<p>{}</p>", inline(t, wikilinks, embeds))); }
    }
    if in_code { html.push_str("</code></pre>"); }
    html.replace("</ul><ul>", "").replace("</ul data-type=\"taskList\"><ul data-type=\"taskList\">", "")
}

#[tauri::command]
pub async fn import_obsidian_vault(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    workspace_id: String,
    folder: String,
) -> Result<ObsidianImportResult, String> {
    let dir = Path::new(&folder);
    if !dir.exists() || !dir.is_dir() {
        return Err("That folder does not exist.".into());
    }
    // All markdown notes.
    let mut md_files: Vec<PathBuf> = Vec::new();
    collect_note_files(dir, 0, &mut md_files);
    md_files.retain(|p| {
        let e = p.extension().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        e == "md" || e == "markdown"
    });
    if md_files.is_empty() {
        return Err("No .md notes found in that vault.".into());
    }
    // Index every non-markdown file by lowercase filename for attachment/embed resolution.
    let mut all_files: Vec<PathBuf> = Vec::new();
    collect_all_files(dir, 0, &mut all_files);
    let mut attach_index: HashMap<String, PathBuf> = HashMap::new();
    for f in &all_files {
        if let Some(name) = f.file_name() {
            attach_index.entry(name.to_string_lossy().to_lowercase()).or_insert_with(|| f.clone());
        }
    }

    let notes_dir = get_loom_notes_dir(&app_handle)?;
    let files_dir = get_loom_files_dir(&app_handle)?;

    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

    let mut result = ObsidianImportResult::default();
    // basename/title/alias (lowercased) -> note item id, for wikilink resolution.
    let mut resolver: HashMap<String, String> = HashMap::new();
    // (note_id, [wikilink targets]) collected in pass 1, wired in pass 2.
    let mut pending_links: Vec<(String, Vec<String>)> = Vec::new();

    for path in &md_files {
        let content = match fs::read_to_string(path) { Ok(c) => c, Err(_) => { result.skipped += 1; continue; } };
        let (fm, body) = parse_frontmatter(&content);
        let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let title = fm.get("title").and_then(|v| v.first()).cloned().unwrap_or_else(|| stem.clone());

        let mut wikilinks: Vec<String> = Vec::new();
        let mut embeds: Vec<String> = Vec::new();
        let mut html = obsidian_md_to_html(&body, &mut wikilinks, &mut embeds);

        // Copy + register each embed, then point the placeholder at the real path.
        for (i, name) in embeds.iter().enumerate() {
            let key = name.rsplit(['/', '\\']).next().unwrap_or(name).to_lowercase();
            let placeholder = format!("__EMBED_{}__", i);
            if let Some(src) = attach_index.get(&key) {
                let dest = generate_unique_path(files_dir.join(src.file_name().unwrap_or_default()));
                if fs::copy(src, &dest).is_ok() {
                    let dest_str = dest.to_string_lossy().to_string();
                    let fname = dest.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let ext = dest.extension().map(|s| s.to_string_lossy().to_lowercase());
                    let mime = ext.as_deref().map(guess_mime_type);
                    let (size, modified) = extract_metadata(&dest);
                    let _ = create_file_entry_impl(&conn, workspace_id.clone(), fname.clone(), dest_str.clone(), fname.clone(), ext, mime, size, modified);
                    html = html.replace(&placeholder, &escape_html(&dest_str));
                    result.attachments += 1;
                    continue;
                }
            }
            // Unresolved embed: drop the dead link target but keep the visible name.
            html = html.replace(&format!("data-attachment=\"{}\"", placeholder), "");
        }

        // Tags: frontmatter `tags` + inline #hashtags (deduped).
        let mut tags: Vec<String> = fm.get("tags").cloned().unwrap_or_default();
        let hashtag = regex::Regex::new(r"(?:^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)").unwrap();
        for c in hashtag.captures_iter(&body) {
            let t = c[1].to_string();
            if !tags.iter().any(|x| x.eq_ignore_ascii_case(&t)) { tags.push(t); }
        }
        let aliases: Vec<String> = fm.get("aliases").cloned().unwrap_or_default();

        // Plain-text + preview for search/list.
        let tag_re = regex::Regex::new(r"(?is)<[^>]+>").unwrap();
        let plain = tag_re.replace_all(&html, " ").replace("&nbsp;", " ");
        let plain = plain.split_whitespace().collect::<Vec<_>>().join(" ");
        let words = plain.split_whitespace().count();
        let preview: String = plain.chars().take(140).collect();
        let first_tag = tags.first().cloned().unwrap_or_default();

        let meta = serde_json::json!({
            "folder": "Obsidian",
            "words": words,
            "preview": preview,
            "full_text": plain.chars().take(20_000).collect::<String>(),
            "tag": first_tag,
            "tags": tags,
            "aliases": aliases,
            "source": "obsidian",
        });
        let meta_str = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".into());

        // Write the note file and register the item.
        let sanitized = sanitize_filename(&title);
        let dest = generate_unique_path(notes_dir.join(format!("{}.html", sanitized)));
        let final_filename = dest.file_name().unwrap_or_default().to_string_lossy().to_string();
        let final_title = dest.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let document = format!("<h1>{}</h1>{}", escape_html(&final_title), html);
        if fs::write(&dest, document.as_bytes()).is_err() { result.skipped += 1; continue; }
        let path_str = dest.to_string_lossy().to_string();
        let (size, modified) = extract_metadata(&dest);

        let note_id: Result<String, String> = (|| {
            let id = conn.query_row(
                "INSERT INTO items (id, workspace_id, title, item_type, metadata, tag) VALUES (lower(hex(randomblob(16))), ?, ?, 'note', ?, ?) RETURNING id",
                rusqlite::params![workspace_id, final_title, meta_str, first_tag],
                |row| row.get::<_, String>(0),
            ).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO files (id, path, filename, extension, mime_type, size_bytes, created_at, modified_at, favorite, tags)
                 VALUES (?, ?, ?, 'html', 'text/html', ?, strftime('%s','now'), ?, 0, ?)",
                rusqlite::params![id, path_str, final_filename, size, modified, tags.join(",")],
            ).map_err(|e| e.to_string())?;
            Ok(id)
        })();

        let note_id = match note_id { Ok(id) => id, Err(_) => { let _ = fs::remove_file(&dest); result.skipped += 1; continue; } };
        result.imported += 1;

        // Register every name this note can be linked by.
        resolver.entry(stem.to_lowercase()).or_insert_with(|| note_id.clone());
        resolver.entry(final_title.to_lowercase()).or_insert_with(|| note_id.clone());
        for a in &aliases { resolver.entry(a.to_lowercase()).or_insert_with(|| note_id.clone()); }
        pending_links.push((note_id, wikilinks));
    }

    // Pass 2: wire resolved wikilinks into real graph edges.
    for (source_id, targets) in &pending_links {
        for t in targets {
            if let Some(target_id) = resolver.get(&wikilink_key(t)) {
                if target_id != source_id {
                    if create_link_impl(&conn, source_id.clone(), target_id.clone(), "wikilink".into()).is_ok() {
                        result.links_created += 1;
                    }
                }
            }
        }
    }

    Ok(result)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// Like collect_note_files but every file (used to index attachments).
fn collect_all_files(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 8 { return; }
    let entries = match fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            collect_all_files(&path, depth + 1, out);
        } else if path.is_file() {
            out.push(path);
        }
    }
}

// ── Maintenance: custom CSS folder + database optimization ──
fn get_custom_css_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data_dir.join("CustomCSS");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Seed a starter file so the folder is self-explanatory.
        let readme = dir.join("custom.css");
        if !readme.exists() {
            let _ = fs::write(&readme, b"/* LOOM custom CSS. Any .css file here loads at launch. */\n");
        }
    }
    Ok(dir)
}

#[tauri::command]
pub async fn reveal_custom_css_folder(app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = get_custom_css_dir(&app_handle)?;
    opener::open(dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_custom_css(app_handle: tauri::AppHandle) -> Result<String, String> {
    let dir = get_custom_css_dir(&app_handle)?;
    let mut combined = String::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("css") {
                if let Ok(css) = fs::read_to_string(&path) {
                    combined.push_str(&css);
                    combined.push('\n');
                }
            }
        }
    }
    Ok(combined)
}

#[tauri::command]
pub async fn optimize_database(state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<i64, String> {
    let db_path = app_handle.path().app_data_dir().map_err(|e| e.to_string())?.join("loom.db");
    let before = fs::metadata(&db_path).map(|m| m.len() as i64).unwrap_or(0);
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {

        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;").map_err(|e| e.to_string())?;
    Ok(())
        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)?;
    
    let after = std::fs::metadata(&db_path).map(|m| m.len() as i64).unwrap_or(0);
    Ok((before - after).max(0))
}

#[tauri::command]
pub async fn fs_reconcile(state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<(), String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let files_dir = get_loom_files_dir(&app_handle)?;
    let notes_dir = get_loom_notes_dir(&app_handle)?;

    let mut stmt = conn.prepare(
        "SELECT f.id, f.path FROM files f JOIN items i ON f.id = i.id WHERE i.deleted = 0"
    ).map_err(|e| e.to_string())?;

    let mut to_soft_delete = Vec::new();
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| e.to_string())?;

    for row in rows {
        if let Ok((id, path_str)) = row {
            let p = Path::new(&path_str);
            if !p.exists() {
                to_soft_delete.push(id);
            }
        }
    }
    drop(stmt);

    if !to_soft_delete.is_empty() {
        let payload = format!(r#"{{"ids":{:?},"action":"reconcile_missing"}}"#, to_soft_delete);
        let _ = execute_two_phase(&mut conn, "reconcile_missing", &payload, |tx| {
            for id in &to_soft_delete {
                tx.execute("UPDATE items SET deleted = 1 WHERE id = ?", [id]).map_err(|e| e.to_string())?;
            }
            Ok(())
        });
    }

    if let Ok(entries) = fs::read_dir(&files_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let path_str = path.to_string_lossy().to_string();
                let exists: bool = conn.query_row(
                    "SELECT COUNT(*) FROM files f JOIN items i ON f.id = i.id WHERE f.path = ? AND i.deleted = 0",
                    [&path_str],
                    |r| r.get::<_, i64>(0),
                ).unwrap_or(0) > 0;

                if !exists {
                    let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let title = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                    let ext = path.extension().map(|s| s.to_string_lossy().to_string().to_lowercase());
                    let mime = ext.as_deref().map(guess_mime_type);
                    let (size, modified) = extract_metadata(&path);
                    
                    let workspace_id: String = conn.query_row(
                        "SELECT id FROM workspaces LIMIT 1",
                        [],
                        |r| r.get(0)
                    ).unwrap_or_else(|_| "default".to_string());

                    let payload = format!(r#"{{"workspace_id":"{}","title":"{}","action":"reindex_untracked_file"}}"#, workspace_id, title);
                    let _ = execute_two_phase(&mut conn, "reindex_untracked_file", &payload, |tx| {
                        create_file_entry_impl(tx, workspace_id.clone(), title.clone(), path_str.clone(), filename.clone(), ext.clone(), mime.clone(), size, modified)
                    });
                }
            }
        }
    }

    if let Ok(entries) = fs::read_dir(&notes_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("html") {
                let path_str = path.to_string_lossy().to_string();
                let exists: bool = conn.query_row(
                    "SELECT COUNT(*) FROM files f JOIN items i ON f.id = i.id WHERE f.path = ? AND i.deleted = 0",
                    [&path_str],
                    |r| r.get::<_, i64>(0),
                ).unwrap_or(0) > 0;

                if !exists {
                    let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let title = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                    let (size, modified) = extract_metadata(&path);
                    
                    let workspace_id: String = conn.query_row(
                        "SELECT id FROM workspaces LIMIT 1",
                        [],
                        |r| r.get(0)
                    ).unwrap_or_else(|_| "default".to_string());

                    let payload = format!(r#"{{"workspace_id":"{}","title":"{}","action":"reindex_untracked_note"}}"#, workspace_id, title);
                    let _ = execute_two_phase(&mut conn, "reindex_untracked_note", &payload, |tx| {
                        let id = tx.query_row(
                            "INSERT INTO items (id, workspace_id, title, item_type, metadata) VALUES (lower(hex(randomblob(16))), ?, ?, 'note', '{}') RETURNING id",
                            [workspace_id.clone(), title.clone()],
                            |row| row.get::<_, String>(0),
                        ).map_err(|e| e.to_string())?;

                        tx.execute(
                            "INSERT INTO files (id, path, filename, extension, mime_type, size_bytes, created_at, modified_at, favorite, tags) 
                             VALUES (?, ?, ?, 'html', 'text/html', ?, strftime('%s','now'), ?, 0, '')",
                            rusqlite::params![id.clone(), path_str.clone(), filename.clone(), size, modified],
                        ).map_err(|e| e.to_string())?;
                        Ok(())
                    });
                }
            }
        }
    }

    Ok(())

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct IndexResult {
    pub indexed: u32,
    pub skipped: u32,
    pub total: u32,
}

/// Read text-based files and fold their plain-text content into the owning item's
/// metadata under `full_text`, so the existing search (which LIKE-matches metadata)
/// can find files by their contents. This is real full-text indexing wired into the
/// search/DB pipeline — not OCR (the app has no OCR engine).
#[tauri::command]
pub async fn index_text_files(state: State<'_, AppState>, workspace_id: String) -> Result<IndexResult, String> {
    state.db.call(move |conn| {
        let res = (|| -> Result<_, String> {


    // Pull every active file row + its current item metadata.
    let mut stmt = conn.prepare(
        "SELECT f.id, f.path, f.extension, i.metadata
         FROM files f JOIN items i ON f.id = i.id
         WHERE i.workspace_id = ? AND i.deleted = 0 AND i.item_type = 'file'"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([&workspace_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
        ))
    }).map_err(|e| e.to_string())?;

    const MAX_BYTES: u64 = 4 * 1024 * 1024; // skip files larger than 4 MB
    let text_exts = ["txt", "md", "markdown", "csv", "log", "json", "html", "htm", "xml", "yml", "yaml", "rtf"];

    let mut indexed = 0u32;
    let mut skipped = 0u32;
    let mut total = 0u32;
    let mut updates: Vec<(String, String)> = Vec::new();

    for row in rows {
        let (id, path, ext, metadata) = row.map_err(|e| e.to_string())?;
        total += 1;
        let ext_l = ext.unwrap_or_default().to_lowercase();
        if !text_exts.contains(&ext_l.as_str()) {
            skipped += 1;
            continue;
        }
        let p = Path::new(&path);
        match fs::metadata(p) {
            Ok(m) if m.len() <= MAX_BYTES => {}
            _ => { skipped += 1; continue; }
        }
        let content = match fs::read_to_string(p) {
            Ok(c) => c,
            Err(_) => { skipped += 1; continue; }
        };
        // For html/xml/rtf, reduce to plain text; others are already text.
        let plain = if ext_l == "html" || ext_l == "htm" || ext_l == "xml" {
            let tag_re = regex::Regex::new(r"(?is)<[^>]+>").unwrap();
            tag_re.replace_all(&content, " ").to_string()
        } else if ext_l == "rtf" {
            rtf_to_html(&content) // returns <p>-wrapped lines; strip tags below
        } else {
            content
        };
        let ws_re = regex::Regex::new(r"\s+").unwrap();
        let tag_re = regex::Regex::new(r"(?is)<[^>]+>").unwrap();
        let cleaned = ws_re.replace_all(&tag_re.replace_all(&plain, " "), " ").trim().to_string();
        // Cap stored text to keep metadata reasonable.
        let snippet: String = cleaned.chars().take(20_000).collect();

        // Merge full_text into existing metadata JSON.
        let mut meta_val: serde_json::Value =
            serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({}));
        if !meta_val.is_object() {
            meta_val = serde_json::json!({});
        }
        meta_val["full_text"] = serde_json::Value::String(snippet);
        let new_meta = serde_json::to_string(&meta_val).map_err(|e| e.to_string())?;
        updates.push((id, new_meta));
        indexed += 1;
    }
    drop(stmt);

    for (id, new_meta) in updates {
        conn.execute("UPDATE items SET metadata = ?1 WHERE id = ?2", rusqlite::params![new_meta, id])
            .map_err(|e| e.to_string())?;
    }

    Ok(IndexResult { indexed, skipped, total })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// Encrypt/decrypt a tracked file IN PLACE — the item id (and therefore every link to
// it) is preserved. We crypt on disk first, then repoint the files row + item title in
// one transaction. If the DB update fails, we roll the file back to its old name.
fn requery_file_entry(conn: &rusqlite::Connection, id: &str) -> Result<FileEntry, String> {
    let mut stmt = conn.prepare(
        "SELECT i.id, i.workspace_id, i.item_type, i.title,
                f.path, f.filename, f.extension, f.mime_type, f.size_bytes, f.modified_at, f.favorite, f.tags
         FROM items i JOIN files f ON i.id = f.id WHERE i.id = ?"
    ).map_err(|e| e.to_string())?;
    stmt.query_row([id], |row| {
        Ok(FileEntry {
            id: row.get(0)?, workspace_id: row.get(1)?, item_type: row.get(2)?, title: row.get(3)?,
            path: row.get(4)?, filename: row.get(5)?, extension: row.get(6)?, mime_type: row.get(7)?,
            size_bytes: row.get(8)?, modified_at: row.get(9)?, favorite: row.get::<_, i32>(10)? != 0, tags: row.get(11)?,
        })
    }).map_err(|e| e.to_string())
}

// --- Crash-safe FS op ledger ---------------------------------------------
// Record intent BEFORE mutating disk so a crash between the disk op and the DB
// commit can be repaired in place at startup (item id preserved) instead of
// being identity-split by fs_reconcile (orphaned links + a new-UUID re-import).

fn record_pending_fs_op(conn: &rusqlite::Connection, item_id: &str, src: &str, dest: &str, op_type: &str) -> Result<String, String> {
    conn.query_row(
        "INSERT INTO pending_fs_ops (id, item_id, src_path, dest_path, op_type, status)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 'PENDING') RETURNING id",
        rusqlite::params![item_id, src, dest, op_type],
        |r| r.get(0),
    ).map_err(|e| e.to_string())
}

fn clear_pending_fs_op(conn: &rusqlite::Connection, op_id: &str) {
    let _ = conn.execute("DELETE FROM pending_fs_ops WHERE id = ?", [op_id]);
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct PendingOpRecovery {
    pub finished: u32,
    pub rolled_back: u32,
    pub lost: u32,
}

// Repoint the files row + item title onto `dest`, keeping the item id, then drop
// the ledger row — all in one transaction. Used by startup recovery to FINISH a
// disk mutation whose DB commit was lost to a crash.
fn finish_repoint(conn: &mut rusqlite::Connection, item_id: &str, dest: &str, op_id: &str) -> Result<(), String> {
    let np = Path::new(dest);
    let filename = np.file_name().unwrap_or_default().to_string_lossy().to_string();
    let title = np.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext = np.extension().map(|s| s.to_string_lossy().to_string().to_lowercase());
    let (size, modified) = extract_metadata(np);
    let payload = format!(r#"{{"id":"{}","action":"recover_pending_fs_op"}}"#, item_id);
    execute_two_phase(conn, "recover_pending_fs_op", &payload, |tx| {
        tx.execute("UPDATE items SET title = ? WHERE id = ?", rusqlite::params![title, item_id]).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE files SET path = ?, filename = ?, extension = ?, size_bytes = ?, modified_at = ? WHERE id = ?",
            rusqlite::params![dest, filename, ext, size, modified, item_id],
        ).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM pending_fs_ops WHERE id = ?", [op_id]).map_err(|e| e.to_string())?;
        Ok(())
    })
}

// Startup recovery: finish or roll back every PENDING file op. MUST run before
// fs_reconcile. Decision is driven purely by what is on disk:
//   dest present, src gone  -> disk op completed, DB commit lost -> FINISH (repoint to dest)
//   src present (any dest)   -> DB still points at src (valid)   -> ROLLBACK (drop orphan dest)
//   neither present          -> data is gone (should not happen) -> drop op, fs_reconcile soft-deletes
pub fn recover_pending_fs_ops(conn: &mut rusqlite::Connection) -> Result<PendingOpRecovery, String> {
    let mut stmt = conn
        .prepare("SELECT id, item_id, src_path, dest_path FROM pending_fs_ops WHERE status = 'PENDING'")
        .map_err(|e| e.to_string())?;
    let ops: Vec<(String, String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    drop(stmt);

    let mut stats = PendingOpRecovery::default();
    for (op_id, item_id, src, dest) in ops {
        let src_exists = Path::new(&src).exists();
        let dest_exists = Path::new(&dest).exists();
        if dest_exists && !src_exists {
            finish_repoint(conn, &item_id, &dest, &op_id)?;
            stats.finished += 1;
        } else if src_exists {
            if dest_exists {
                let _ = fs::remove_file(&dest);
            }
            clear_pending_fs_op(conn, &op_id);
            stats.rolled_back += 1;
        } else {
            clear_pending_fs_op(conn, &op_id);
            stats.lost += 1;
        }
    }
    Ok(stats)
}

fn repoint_file(conn: &mut rusqlite::Connection, action: &str, id: &str, old_path: &str, new_path: &str, op_id: &str) -> Result<FileEntry, String> {
    let np = Path::new(new_path);
    let filename = np.file_name().unwrap_or_default().to_string_lossy().to_string();
    let title = np.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext = np.extension().map(|s| s.to_string_lossy().to_string().to_lowercase());
    let (size, modified) = extract_metadata(np);

    let payload = format!(r#"{{"id":"{}","action":"{}"}}"#, id, action);
    let res = execute_two_phase(&mut *conn, action, &payload, |tx| {
        tx.execute("UPDATE items SET title = ? WHERE id = ?", rusqlite::params![title, id]).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE files SET path = ?, filename = ?, extension = ?, size_bytes = ?, modified_at = ? WHERE id = ?",
            rusqlite::params![new_path, filename, ext, size, modified, id],
        ).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM pending_fs_ops WHERE id = ?", [op_id]).map_err(|e| e.to_string())?;
        Ok(())
    });
    if res.is_err() {
        // Roll the on-disk crypto back so DB and disk stay consistent.
        let _ = fs::rename(new_path, old_path);
        clear_pending_fs_op(conn, op_id);
        return Err("Encrypted on disk but failed to register in the database; reverted.".into());
    }
    requery_file_entry(conn, id)
}

#[tauri::command]
pub async fn fs_encrypt_file(state: State<'_, AppState>, id: String, password: String) -> Result<FileEntry, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let old_path: String = conn.query_row("SELECT path FROM files WHERE id = ?", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
    // encrypt_path is deterministic: dest is always "{old_path}.enc". Record the
    // intent before touching disk so a crash mid-op is recoverable.
    let dest = format!("{}.enc", old_path);
    let op_id = record_pending_fs_op(&conn, &id, &old_path, &dest, "encrypt")?;
    let new_path = match crate::crypto_commands::encrypt_path(&old_path, &password) {
        Ok(p) => p,
        Err(e) => { clear_pending_fs_op(&conn, &op_id); return Err(e); }
    };
    repoint_file(&mut conn, "encrypt_file", &id, &old_path, &new_path, &op_id)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

#[tauri::command]
pub async fn fs_decrypt_file(state: State<'_, AppState>, id: String, password: String) -> Result<FileEntry, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let old_path: String = conn.query_row("SELECT path FROM files WHERE id = ?", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
    // decrypt_path is deterministic: dest strips a trailing ".enc", else "{path}.dec".
    let dest = if old_path.ends_with(".enc") {
        old_path[..old_path.len() - 4].to_string()
    } else {
        format!("{}.dec", old_path)
    };
    let op_id = record_pending_fs_op(&conn, &id, &old_path, &dest, "decrypt")?;
    let new_path = match crate::crypto_commands::decrypt_path(&old_path, &password) {
        Ok(p) => p,
        Err(e) => { clear_pending_fs_op(&conn, &op_id); return Err(e); }
    };
    repoint_file(&mut conn, "decrypt_file", &id, &old_path, &new_path, &op_id)

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// These two commands back the "Export / Save As" features: `dest` comes from a user
// `save()` dialog and is meant to land anywhere in the user's space (Desktop, Documents,
// another drive). So we can't confine to app_data — instead we block writes into OS/system
// roots, which is the only path an injected script would target for persistence/RCE.
// ponytail: blocklist of system roots, not an allowlist — broaden the list if a new
// sensitive root shows up. The CSP (script-src 'self') is the primary guard; this is depth.
fn reject_system_path(dest: &Path) -> Result<(), String> {
    let abs = if dest.is_absolute() { dest.to_path_buf() } else {
        std::env::current_dir().map_err(|e| e.to_string())?.join(dest)
    };
    let lower = abs.to_string_lossy().to_lowercase().replace('\\', "/");
    const BLOCKED: &[&str] = &[
        "c:/windows", "c:/program files", "c:/program files (x86)",
        "/etc/", "/bin/", "/sbin/", "/usr/", "/boot/", "/sys/", "/lib",
    ];
    if BLOCKED.iter().any(|b| lower.starts_with(b) || lower == b.trim_end_matches('/')) {
        return Err("Refusing to write to a system directory.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn fs_copy_file(src: String, dest: String) -> Result<(), String> {
    let src_path = Path::new(&src);
    let dest_path = Path::new(&dest);
    reject_system_path(dest_path)?;
    if !src_path.exists() {
        return Err("Source file does not exist".into());
    }
    fs::copy(src_path, dest_path).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_write_any_file(path: String, content: String) -> Result<(), String> {
    let dest = Path::new(&path);
    reject_system_path(dest)?;
    fs::write(dest, content.as_bytes()).map_err(|e| e.to_string())
}

#[derive(Serialize, Debug)]
pub struct SweepResult {
    pub success: bool,
    pub issues_detected: Vec<String>,
    pub repairs_taken: Vec<String>,
}

#[tauri::command]
pub async fn run_integrity_sweep(state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<SweepResult, String> {
    state.db.call(move |mut conn| {
        let res = (|| -> Result<_, String> {

    let files_dir = get_loom_files_dir(&app_handle)?;
    let notes_dir = get_loom_notes_dir(&app_handle)?;

    let mut issues_detected = Vec::new();
    let mut repairs_taken = Vec::new();

    // 1. DB files -> disk checks
    let mut stmt = conn.prepare(
        "SELECT f.id, f.path, i.title, i.item_type FROM files f JOIN items i ON f.id = i.id WHERE i.deleted = 0"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
    }).map_err(|e| e.to_string())?;

    let mut missing_on_disk = Vec::new();
    for row in rows {
        if let Ok((id, path_str, title, item_type)) = row {
            let p = Path::new(&path_str);
            if !p.exists() {
                missing_on_disk.push((id, path_str, title, item_type));
            }
        }
    }
    drop(stmt);

    for (id, path, title, _item_type) in missing_on_disk {
        issues_detected.push(format!("File '{}' ({}) missing on disk at {}", title, id, path));
        let trash_dir = get_trash_dir(&app_handle)?;
        let staged_trash_path = trash_dir.join(&id);
        if staged_trash_path.exists() {
            if let Ok(_) = restore_file_from_trash(&app_handle, &id, &path) {
                repairs_taken.push(format!("Restored file '{}' ({}) from trash to original path", title, id));
                let _ = conn.execute("DELETE FROM trash_ledger WHERE id = ?", [&id]);
            } else {
                repairs_taken.push(format!("Attempted to restore file '{}' ({}) from trash but failed", title, id));
            }
        } else {
            let payload = format!(r#"{{"id":"{}","action":"auto_repair_missing"}}"#, id);
            let _ = execute_two_phase(&mut conn, "auto_repair_missing", &payload, |tx| {
                tx.execute("UPDATE items SET deleted = 1 WHERE id = ?", [&id]).map_err(|e| e.to_string())?;
                Ok(())
            });
            repairs_taken.push(format!("Flagged unrecoverable file '{}' ({}): soft-deleted reference in DB", title, id));
        }
    }

    // 2. Disk files -> DB checks (Orphans)
    let mut scan_dirs = vec![files_dir, notes_dir];
    while let Some(dir) = scan_dirs.pop() {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan_dirs.push(path);
                } else if path.is_file() {
                    let path_str = path.to_string_lossy().to_string();
                    let db_state: Option<(bool, String)> = conn.query_row(
                        "SELECT i.deleted, i.id FROM files f JOIN items i ON f.id = i.id WHERE f.path = ?",
                        [&path_str],
                        |r| Ok((r.get::<_, bool>(0)?, r.get::<_, String>(1)?))
                    ).ok();

                    match db_state {
                        Some((true, id)) => {
                            issues_detected.push(format!("File on disk exists but DB has soft-deleted item: {}", path_str));
                            if let Ok(_) = move_file_to_trash(&app_handle, &id, &path_str) {
                                repairs_taken.push(format!("Staged soft-deleted file on disk to trash: {}", path_str));
                                let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                                let _ = conn.execute(
                                    "INSERT OR REPLACE INTO trash_ledger (id, original_path, filename) VALUES (?1, ?2, ?3)",
                                    [&id, &path_str, &filename],
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    let success = issues_detected.is_empty();
    Ok(SweepResult {
        success,
        issues_detected,
        repairs_taken,
    })

        })();
        Ok(res)
    }).await.map_err(|e| e.to_string()).and_then(|x| x)
}

// ── Managed background image storage ────────────────────────────────────────
// Backgrounds are copied into app_data/backgrounds/ so they are device-portable
// (the archive export already walks all of app_data), survive backup/restore, and
// load reliably regardless of the user's original file location.

fn get_backgrounds_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data_dir.join("backgrounds");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// Copy an image into managed storage and return a portable relative path
/// ("backgrounds/<safe_name>_<timestamp>.<ext>").  The relative path is what
/// gets stored in the settings DB — it can be resolved on any device after a
/// backup/restore because the archive always includes the backgrounds/ folder.
#[tauri::command]
pub async fn bg_import_image(app_handle: tauri::AppHandle, src: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    if !src_path.exists() || !src_path.is_file() {
        return Err("Source image does not exist".into());
    }
    let ext = src_path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !["jpg", "jpeg", "png", "webp", "avif"].contains(&ext.as_str()) {
        return Err("Only jpg, jpeg, png, webp images are supported".into());
    }
    let backgrounds_dir = get_backgrounds_dir(&app_handle)?;
    // Sanitize to alphanumeric/dash/underscore so the filename is safe in CSS url().
    let stem = src_path.file_stem().unwrap_or_default().to_string_lossy();
    let safe_stem: String = stem.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(60)
        .collect();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("{}_{}.{}", safe_stem, ts, ext);
    let dest = backgrounds_dir.join(&filename);
    fs::copy(src_path, &dest)
        .map_err(|e| format!("Failed to copy background image: {}", e))?;
    Ok(format!("backgrounds/{}", filename))
}

/// Resolve a relative managed path ("backgrounds/foo.jpg") to an absolute path.
/// Also accepts legacy absolute paths so old configs work until they are migrated.
#[tauri::command]
pub async fn bg_resolve_path(app_handle: tauri::AppHandle, rel: String) -> Result<String, String> {
    let p = Path::new(&rel);
    if p.is_absolute() {
        // Legacy path: return as-is if it still exists.
        if p.exists() { return Ok(rel); }
        return Err(format!("Background image no longer exists: {}", rel));
    }
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let abs = app_data_dir.join(&rel);
    if !abs.exists() {
        return Err(format!("Managed background not found: {}", rel));
    }
    Ok(abs.to_string_lossy().into_owned())
}

/// Delete a managed background image.  Only operates on paths inside the
/// backgrounds/ folder so it cannot be weaponised to delete arbitrary files.
#[tauri::command]
pub async fn bg_delete_managed(app_handle: tauri::AppHandle, rel: String) -> Result<(), String> {
    if !rel.starts_with("backgrounds/") && !rel.starts_with("backgrounds\\") {
        return Ok(()); // not a managed path, ignore silently
    }
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let abs = app_data_dir.join(&rel);
    // Confirm the resolved path sits inside backgrounds/ to block any path traversal.
    let bg_dir = app_data_dir.join("backgrounds");
    if !abs.starts_with(&bg_dir) {
        return Err("Path traversal detected".into());
    }
    if abs.exists() {
        fs::remove_file(&abs).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_parses_scalars_and_lists() {
        let src = "---\ntitle: My Note\ntags: [a, b]\naliases:\n  - alt one\n  - alt two\n---\nBody line\n";
        let (fm, body) = parse_frontmatter(src);
        assert_eq!(fm.get("title").unwrap(), &vec!["My Note".to_string()]);
        assert_eq!(fm.get("tags").unwrap(), &vec!["a".to_string(), "b".to_string()]);
        assert_eq!(fm.get("aliases").unwrap(), &vec!["alt one".to_string(), "alt two".to_string()]);
        assert_eq!(body.trim(), "Body line");
    }

    #[test]
    fn no_frontmatter_returns_content_unchanged() {
        let (fm, body) = parse_frontmatter("# Heading\ntext");
        assert!(fm.is_empty());
        assert_eq!(body, "# Heading\ntext");
    }

    #[test]
    fn wikilink_key_strips_heading_alias_and_path() {
        assert_eq!(wikilink_key("Folder/Note#Section|Label"), "note");
        assert_eq!(wikilink_key("Simple"), "simple");
    }

    #[test]
    fn md_converter_collects_wikilinks_and_embeds() {
        let mut wl = Vec::new();
        let mut em = Vec::new();
        let html = obsidian_md_to_html("See [[Other Note]] and ![[pic.png]] #idea", &mut wl, &mut em);
        assert_eq!(wl, vec!["Other Note".to_string()]);
        assert_eq!(em, vec!["pic.png".to_string()]);
        assert!(html.contains("data-wikilink=\"Other Note\""));
        assert!(html.contains("class=\"tag\">#idea"));
    }

    fn test_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::database::setup_schema(&conn).unwrap();
        conn.execute("INSERT INTO workspaces (id, name) VALUES ('ws-1','Test')", []).unwrap();
        conn
    }

    // Unique on-disk scratch dir per test so cases never collide.
    fn scratch() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("loom_fsop_test_{}_{:?}", nanos, std::thread::current().id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn mk_item_file(conn: &rusqlite::Connection, id: &str, path: &str) {
        conn.execute(
            "INSERT INTO items (id, workspace_id, item_type, title, metadata, deleted) VALUES (?, 'ws-1', 'file', 'doc', '{}', 0)",
            [id],
        ).unwrap();
        conn.execute(
            "INSERT INTO files (id, path, filename, extension, mime_type, size_bytes, created_at, modified_at, favorite, tags)
             VALUES (?, ?, 'doc.txt', 'txt', 'text/plain', 0, 0, 0, 0, '')",
            rusqlite::params![id, path],
        ).unwrap();
    }

    fn db_path(conn: &rusqlite::Connection, id: &str) -> String {
        conn.query_row("SELECT path FROM files WHERE id = ?", [id], |r| r.get(0)).unwrap()
    }
    fn pending_count(conn: &rusqlite::Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM pending_fs_ops", [], |r| r.get(0)).unwrap()
    }

    // rename crashed AFTER the disk move but BEFORE the DB commit:
    // DB still points at src (gone), dest is on disk. Recovery must FINISH in place,
    // keeping the same item id so an existing link survives (no identity split).
    #[test]
    fn rename_crash_before_commit_finishes_in_place() {
        let mut conn = test_db();
        let dir = scratch();
        let src = dir.join("doc.txt"); let dest = dir.join("renamed.txt");
        fs::write(&dest, b"data").unwrap(); // disk move already happened
        let (src_s, dest_s) = (src.to_string_lossy().to_string(), dest.to_string_lossy().to_string());

        mk_item_file(&conn, "f1", &src_s); // DB still points at the OLD path
        // A second item links to the file item — this is what identity-split would orphan.
        conn.execute("INSERT INTO items (id, workspace_id, item_type, title, metadata, deleted) VALUES ('n1','ws-1','note','n','{}',0)", []).unwrap();
        conn.execute("INSERT INTO links (source_id, target_id, relationship_type) VALUES ('n1','f1','ref')", []).unwrap();
        let op = record_pending_fs_op(&conn, "f1", &src_s, &dest_s, "rename").unwrap();
        assert_eq!(op.len(), 32);

        let stats = recover_pending_fs_ops(&mut conn).unwrap();
        assert_eq!(stats, PendingOpRecovery { finished: 1, rolled_back: 0, lost: 0 });
        assert_eq!(db_path(&conn, "f1"), dest_s); // repointed to dest
        assert_eq!(pending_count(&conn), 0);
        // identity preserved: same id 'f1' still exists, link target still resolves.
        let link_ok: i64 = conn.query_row(
            "SELECT COUNT(*) FROM links l JOIN items i ON l.target_id = i.id WHERE l.source_id='n1' AND i.deleted=0",
            [], |r| r.get(0)).unwrap();
        assert_eq!(link_ok, 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn encrypt_crash_before_commit_finishes() {
        let mut conn = test_db();
        let dir = scratch();
        let src = dir.join("secret.txt"); let dest = dir.join("secret.txt.enc");
        fs::write(&dest, b"cipher").unwrap(); // plaintext already removed, .enc written
        let (src_s, dest_s) = (src.to_string_lossy().to_string(), dest.to_string_lossy().to_string());
        mk_item_file(&conn, "f1", &src_s);
        record_pending_fs_op(&conn, "f1", &src_s, &dest_s, "encrypt").unwrap();

        let stats = recover_pending_fs_ops(&mut conn).unwrap();
        assert_eq!(stats.finished, 1);
        assert_eq!(db_path(&conn, "f1"), dest_s);
        assert_eq!(pending_count(&conn), 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn decrypt_crash_before_commit_finishes() {
        let mut conn = test_db();
        let dir = scratch();
        let src = dir.join("secret.txt.enc"); let dest = dir.join("secret.txt");
        fs::write(&dest, b"plain").unwrap(); // .enc removed, plaintext written
        let (src_s, dest_s) = (src.to_string_lossy().to_string(), dest.to_string_lossy().to_string());
        mk_item_file(&conn, "f1", &src_s);
        record_pending_fs_op(&conn, "f1", &src_s, &dest_s, "decrypt").unwrap();

        let stats = recover_pending_fs_ops(&mut conn).unwrap();
        assert_eq!(stats.finished, 1);
        assert_eq!(db_path(&conn, "f1"), dest_s);
        fs::remove_dir_all(&dir).ok();
    }

    // Crash BEFORE the disk op ran: src still present, dest absent.
    // DB already points at the valid src, so recovery just drops the ledger row.
    #[test]
    fn crash_before_disk_op_rolls_back() {
        let mut conn = test_db();
        let dir = scratch();
        let src = dir.join("doc.txt"); let dest = dir.join("renamed.txt");
        fs::write(&src, b"data").unwrap(); // disk op never happened
        let (src_s, dest_s) = (src.to_string_lossy().to_string(), dest.to_string_lossy().to_string());
        mk_item_file(&conn, "f1", &src_s);
        record_pending_fs_op(&conn, "f1", &src_s, &dest_s, "rename").unwrap();

        let stats = recover_pending_fs_ops(&mut conn).unwrap();
        assert_eq!(stats, PendingOpRecovery { finished: 0, rolled_back: 1, lost: 0 });
        assert_eq!(db_path(&conn, "f1"), src_s); // unchanged, still valid
        assert_eq!(pending_count(&conn), 0);
        fs::remove_dir_all(&dir).ok();
    }

    // Encrypt crashed AFTER writing .enc but BEFORE removing plaintext: both exist.
    // src (plaintext) is valid and DB points at it -> rollback, and the orphan .enc
    // must be deleted so fs_reconcile can't re-import it as a new item.
    #[test]
    fn rollback_removes_orphan_dest_when_src_present() {
        let mut conn = test_db();
        let dir = scratch();
        let src = dir.join("secret.txt"); let dest = dir.join("secret.txt.enc");
        fs::write(&src, b"plain").unwrap();
        fs::write(&dest, b"cipher").unwrap();
        let (src_s, dest_s) = (src.to_string_lossy().to_string(), dest.to_string_lossy().to_string());
        mk_item_file(&conn, "f1", &src_s);
        record_pending_fs_op(&conn, "f1", &src_s, &dest_s, "encrypt").unwrap();

        let stats = recover_pending_fs_ops(&mut conn).unwrap();
        assert_eq!(stats.rolled_back, 1);
        assert_eq!(db_path(&conn, "f1"), src_s);
        assert!(!dest.exists(), "orphan .enc must be removed");
        assert!(src.exists());
        fs::remove_dir_all(&dir).ok();
    }

    // No pending ops -> recovery is a no-op (clean startup path).
    #[test]
    fn no_pending_ops_is_noop() {
        let mut conn = test_db();
        let stats = recover_pending_fs_ops(&mut conn).unwrap();
        assert_eq!(stats, PendingOpRecovery::default());
    }
}
