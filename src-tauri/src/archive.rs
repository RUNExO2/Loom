// .loom workspace archive: a single portable zip of the entire app data directory —
// database (incl. settings + themes), notes, files/attachments, custom CSS, covers.
//
// Restore is staged: the picked archive is validated and copied to `pending_restore.loom`,
// then applied at the NEXT startup BEFORE the DB connection opens (apply_pending_restore).
// This avoids overwriting loom.db while it is open/locked.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{Manager, State};
use crate::AppState;

const PENDING_RESTORE: &str = "pending_restore.loom";

fn should_skip(rel: &Path) -> bool {
    let s = rel.to_string_lossy();
    s.starts_with(".trash")
        || s == PENDING_RESTORE
        || s.ends_with(".db-wal")
        || s.ends_with(".db-shm")
        || s.ends_with(".db-journal")
        || s.ends_with(".loom") // never nest an archive inside the archive
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
    for entry in entries.flatten() {
        let path = entry.path();
        let rel = path.strip_prefix(base).unwrap_or(&path).to_path_buf();
        if should_skip(&rel) { continue; }
        if path.is_dir() {
            walk(&path, base, out);
        } else if path.is_file() {
            out.push(path);
        }
    }
}

#[tauri::command]
pub async fn export_workspace_archive(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    dest: String,
) -> Result<u64, String> {
    // Flush WAL into the main db file so the zipped loom.db is complete.
    state.db.call(|conn| {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        Ok(())
    }).await.map_err(|e| e.to_string())?;

    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    walk(&app_data_dir, &app_data_dir, &mut files);
    if files.is_empty() {
        return Err("Nothing to export.".into());
    }

    let out = fs::File::create(&dest).map_err(|e| format!("Failed to create archive: {}", e))?;
    let mut zip = zip::ZipWriter::new(out);
    let options = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut count = 0u64;
    for path in files {
        let rel = path.strip_prefix(&app_data_dir).map_err(|e| e.to_string())?;
        // Forward slashes for portable zip entry names.
        let name = rel.to_string_lossy().replace('\\', "/");
        let bytes = match fs::read(&path) { Ok(b) => b, Err(_) => continue };
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
        count += 1;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub async fn import_workspace_archive(
    app_handle: tauri::AppHandle,
    src: String,
) -> Result<(), String> {
    let src_path = Path::new(&src);
    if !src_path.is_file() {
        return Err("Archive file not found.".into());
    }
    // Validate: must be a zip that actually contains a loom.db.
    let file = fs::File::open(src_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "Not a valid .loom archive.".to_string())?;
    let has_db = (0..archive.len()).any(|i| archive.by_index(i).map(|f| f.name() == "loom.db").unwrap_or(false));
    if !has_db {
        return Err("Archive does not contain a workspace database (loom.db).".into());
    }

    // Stage it: applied at next startup before the DB opens.
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    let staged = app_data_dir.join(PENDING_RESTORE);
    fs::copy(src_path, &staged).map_err(|e| format!("Failed to stage restore: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skips_transient_and_archives_real_data() {
        assert!(should_skip(Path::new(".trash/x")));
        assert!(should_skip(Path::new("loom.db-wal")));
        assert!(should_skip(Path::new("pending_restore.loom")));
        assert!(should_skip(Path::new("backup.loom")));
        assert!(!should_skip(Path::new("loom.db")));
        assert!(!should_skip(Path::new("Notes/My Note.html")));
        assert!(!should_skip(Path::new("Files/photo.png")));
    }
}

// Called at startup BEFORE the DB connection is opened. If a restore was staged, the
// current loom.db is backed up and the archive is extracted over the app data dir.
pub fn apply_pending_restore(app_data_dir: &Path) -> Result<bool, String> {
    let staged = app_data_dir.join(PENDING_RESTORE);
    if !staged.exists() { return Ok(false); }

    let file = fs::File::open(&staged).map_err(|e| e.to_string())?;
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(_) => { let _ = fs::remove_file(&staged); return Err("Staged archive was corrupt; discarded.".into()); }
    };

    // Back up the current db so a botched restore is recoverable.
    let db = app_data_dir.join("loom.db");
    if db.exists() {
        let _ = fs::copy(&db, app_data_dir.join("loom.db.pre-restore"));
    }

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let rel = match entry.enclosed_name() { Some(p) => p.to_path_buf(), None => continue }; // rejects zip-slip
        let dest = app_data_dir.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&dest).ok();
            continue;
        }
        if let Some(parent) = dest.parent() { fs::create_dir_all(parent).ok(); }
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_ok() {
            fs::write(&dest, &buf).map_err(|e| e.to_string())?;
        }
    }
    // Drop transient WAL/SHM from the OLD db so the restored db file is authoritative.
    let _ = fs::remove_file(app_data_dir.join("loom.db-wal"));
    let _ = fs::remove_file(app_data_dir.join("loom.db-shm"));
    let _ = fs::remove_file(&staged);
    Ok(true)
}
