pub mod database;
mod commands;
mod automation;
mod export;
mod projections;
mod fs_commands;
mod dashboard_commands;
mod library_commands;
mod content_commands;
mod crypto_commands;
use database::init_db;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use std::sync::atomic::{AtomicBool, Ordering};

pub static SYSTEM_FROZEN: AtomicBool = AtomicBool::new(false);

pub struct AppState {
    pub db: tokio_rusqlite::Connection,
    // Path to the SQLite file. The automation engine and scheduler open their own
    // connections to it (WAL) so they never re-enter the command Mutex.
    pub db_path: String,
    // Handle used by the engine to broadcast a refresh event to every window after a
    // backend-originated mutation, so the frontend cache reconciles with SQLite.
    pub app_handle: tauri::AppHandle,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data directory");
            
            let db_path = app_data_dir.join("loom.db");
            let db_path_str = db_path.to_string_lossy().into_owned();
            let mut conn = init_db(&db_path_str).expect("Failed to initialize database");
            
            // Run global integrity check on startup
            if let Ok(integrity) = commands::verify_integrity_all(&conn) {
                if !integrity.ok {
                    println!("WARNING: Database integrity issues detected on startup:");
                    println!("Orphan links: {:?}", integrity.orphan_links);
                    println!("Missing refs: {:?}", integrity.missing_refs);
                    println!("Broken constraints: {:?}", integrity.broken_constraints);
                    println!("Suggested actions: {:?}", integrity.repair_actions);
                } else {
                    println!("SUCCESS: Database integrity verified on startup.");
                }
            } else {
                println!("ERROR: Failed to run integrity verification.");
            }

            // Close out any execution left RUNNING by a previous crash/kill, so the
            // stats don't show a phantom in-flight run forever.
            automation::recover_interrupted(&conn);

            // Finish or roll back any file rename/encrypt/decrypt that crashed between
            // the disk mutation and the DB commit. MUST run before fs_reconcile so a
            // half-done op is repaired in place (item id + links preserved) instead of
            // being identity-split into a new-UUID re-import.
            match fs_commands::recover_pending_fs_ops(&mut conn) {
                Ok(r) if r.finished + r.rolled_back + r.lost > 0 => {
                    println!("Recovered pending FS ops: {} finished, {} rolled back, {} lost", r.finished, r.rolled_back, r.lost);
                }
                Ok(_) => {}
                Err(e) => println!("WARNING: pending FS op recovery failed: {}", e),
            }
            
            drop(conn);
            let t_db = tauri::async_runtime::block_on(async {
                tokio_rusqlite::Connection::open(&db_path_str).await.expect("Failed to open async db")
            });

            let state = AppState {
                db: t_db,
                db_path: db_path_str.clone(),
                app_handle: app.handle().clone(),
            };

            app.manage(state);

            // Reconcile filesystem indexes on startup
            let app_handle = app.handle().clone();
            let state_ref = app.handle().state::<AppState>();
            tauri::async_runtime::block_on(async move {
                if let Err(e) = fs_commands::fs_reconcile(state_ref, app_handle).await {
                    println!("WARNING: Startup filesystem reconciliation failed: {}", e);
                }
            });

            // Automation scheduler — own SQLite connection (WAL), fixed 30s tick.
            // Drives interval/daily triggers off persisted execution timestamps, so
            // it survives restarts without in-memory timer drift.
            let sched_db = db_path_str.clone();
            let sched_app = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(30));
                if crate::SYSTEM_FROZEN.load(Ordering::SeqCst) {
                    continue;
                }
                if let Ok(mut conn) = automation::open_engine_conn(&sched_db) {
                    // Reconcile the frontend cache only when a scheduled run mutated data.
                    if automation::scheduler_tick(&mut conn) {
                        let _ = sched_app.emit(automation::DATA_CHANGED_EVENT, "");
                    }
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            export::export_data,
            export::backup_database,
            export::import_data,
            commands::create_workspace,
            commands::get_workspaces,
            commands::update_workspace,
            commands::delete_workspace,
            commands::create_item,
            commands::get_items,
            commands::update_item,
            commands::delete_item,
            commands::restore_snapshot,
            commands::update_item_intent,
            commands::update_item_metadata,
            commands::create_link,
            commands::delete_link,
            commands::get_links,
            commands::get_all_links,
            commands::search_items,
            commands::verify_integrity,
            commands::get_system_state,
            commands::get_setting,
            commands::set_setting,
            commands::get_mutation_ledger,
            commands::get_system_health,
            commands::repair_integrity,
            projections::get_timeline,
            projections::get_stats,
            fs_commands::fs_create_file,
            fs_commands::fs_import_file,
            fs_commands::fs_open_file,
            fs_commands::fs_reveal_in_explorer,
            fs_commands::fs_delete_file,
            fs_commands::fs_get_files,
            fs_commands::fs_rename_file,
            fs_commands::fs_create_note,
            fs_commands::fs_read_note_content,
            fs_commands::fs_write_note_content,
            fs_commands::fs_import_note_file,
            fs_commands::fs_reconcile,
            fs_commands::fs_copy_file,
            fs_commands::fs_write_any_file,
            fs_commands::run_integrity_sweep,
            dashboard_commands::get_dashboard_layout,
            dashboard_commands::save_dashboard_layout,
            library_commands::fetch_cover_candidates,
            library_commands::download_and_cache_cover,
            content_commands::fetch_readable_article,
            crypto_commands::is_file_encrypted,
            crypto_commands::encrypt_vault_value,
            crypto_commands::decrypt_vault_value,
            fs_commands::fs_encrypt_file,
            fs_commands::fs_decrypt_file,
            fs_commands::index_text_files,
            fs_commands::import_notes_from_folder,
            fs_commands::reveal_custom_css_folder,
            fs_commands::get_custom_css,
            fs_commands::optimize_database,
            automation::run_automation_now,
            automation::emit_event,
            automation::get_automation_executions,
            automation::get_automation_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
