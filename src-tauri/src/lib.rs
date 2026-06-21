pub mod database;
mod commands;
mod automation;
mod archive;
mod export;
mod projections;
mod fs_commands;
mod recovery;
mod dashboard_commands;
mod library_commands;
mod content_commands;
mod crypto_commands;
mod vault_hello;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data directory");

            // Apply a staged .loom restore BEFORE the DB opens (loom.db not yet locked).
            match archive::apply_pending_restore(&app_data_dir) {
                Ok(true) => println!("Restored workspace from staged .loom archive."),
                Ok(false) => {}
                Err(e) => println!("WARNING: workspace restore failed: {}", e),
            }

            let db_path = app_data_dir.join("loom.db");
            let db_path_str = db_path.to_string_lossy().into_owned();
            // Corruption self-heals (file quarantined, fresh DB). A non-recoverable open
            // error (locked by another instance, disk/permission) shows a diagnostic and
            // exits cleanly instead of a silent `expect()` panic with no popup.
            let mut conn = match database::init_db_or_recover(&db_path_str) {
                Ok(c) => c,
                Err(e) => {
                    use tauri_plugin_dialog::DialogExt;
                    app.dialog()
                        .message(format!(
                            "Loom could not open its database.\n\n{}\n\nYour data has not been changed. Close any other running copy of Loom and try again. A pre-migration backup may exist next to:\n{}",
                            e, db_path_str
                        ))
                        .title("Loom — Database Error")
                        .blocking_show();
                    std::process::exit(1);
                }
            };
            
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

            // Reconcile mutation_ledger: STAGED rows left by a crash become FAILED (the
            // transaction already rolled back), then cap the log so it can't grow forever.
            match commands::sweep_stale_ledger(&conn) {
                Ok((r, p)) if r + p > 0 => println!("Ledger sweep: {} staged->failed, {} pruned", r, p),
                Ok(_) => {}
                Err(e) => println!("WARNING: ledger sweep failed: {}", e),
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
            commands::create_saved_search,
            commands::get_saved_searches,
            commands::delete_saved_search,
            recovery::get_deletion_history,
            recovery::restore_deleted_item,
            recovery::create_workspace_snapshot,
            recovery::get_workspace_snapshots,
            recovery::delete_workspace_snapshot,
            recovery::restore_workspace_snapshot,
            commands::verify_integrity,
            commands::get_system_state,
            commands::get_setting,
            commands::set_setting,
            commands::get_theme_presets,
            commands::save_theme_preset,
            commands::delete_theme_preset,
            commands::duplicate_theme_preset,
            commands::rename_theme_preset,
            commands::get_mutation_ledger,
            commands::get_system_health,
            commands::repair_integrity,
            projections::get_timeline,
            projections::get_stats,
            projections::get_activity_feed,
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
            fs_commands::bg_import_image,
            fs_commands::bg_save_image_bytes,
            fs_commands::bg_resolve_path,
            fs_commands::bg_delete_managed,
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
            fs_commands::import_obsidian_vault,
            archive::export_workspace_archive,
            archive::import_workspace_archive,
            vault_hello::hello_available,
            vault_hello::hello_enrolled,
            vault_hello::hello_enable,
            vault_hello::hello_disable,
            vault_hello::hello_unlock,
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
