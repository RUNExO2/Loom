import { apiInvoke } from "./index";

export interface FileEntry {
  id: string;
  workspace_id: string;
  item_type: string;
  title: string;
  path: string;
  filename: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  modified_at: number | null;
  favorite: boolean;
  tags: string | null;
}

export const fsCreateFile = (workspaceId: string, title: string, extension: string | null, folder: string) =>
  apiInvoke<FileEntry>("fs_create_file", { workspaceId, title, extension, folder });

export const fsImportFile = (workspaceId: string, sourcePath: string, strategy: string) =>
  apiInvoke<FileEntry>("fs_import_file", { workspaceId, sourcePath, strategy });

export const fsOpenFile = (path: string) =>
  apiInvoke<void>("fs_open_file", { path });

export const fsRevealInExplorer = (path: string) =>
  apiInvoke<void>("fs_reveal_in_explorer", { path });

export const fsDeleteFile = (id: string) =>
  apiInvoke<string>("fs_delete_file", { id });

export const fsGetFiles = (workspaceId: string) =>
  apiInvoke<FileEntry[]>("fs_get_files", { workspaceId });

export const fsRenameFile = (id: string, newTitle: string) =>
  apiInvoke<FileEntry>("fs_rename_file", { id, newTitle });

export const fsCreateNote = (workspaceId: string, title: string) =>
  apiInvoke<FileEntry>("fs_create_note", { workspaceId, title });

export const fsReadNoteContent = (path: string) =>
  apiInvoke<string>("fs_read_note_content", { path });

export const fsWriteNoteContent = (id: string, content: string) =>
  apiInvoke<void>("fs_write_note_content", { id, content });

export const fsImportNoteFile = (workspaceId: string, sourcePath: string) =>
  apiInvoke<FileEntry>("fs_import_note_file", { workspaceId, sourcePath });

export const fsReconcile = () =>
  apiInvoke<void>("fs_reconcile");

export const fsCopyFile = (src: string, dest: string) =>
  apiInvoke<void>("fs_copy_file", { src, dest });

export const fsWriteAnyFile = (path: string, content: string) =>
  apiInvoke<void>("fs_write_any_file", { path, content });

// ── Managed background image storage ──────────────────────────────────────────
// These three commands implement the copy-into-managed-storage pattern that makes
// backgrounds portable across devices, backups, and workspace exports/imports.

/** Copy an image file into app_data/backgrounds/ and return a portable relative path. */
export const bgImportImage = (src: string) =>
  apiInvoke<string>("bg_import_image", { src });

/** Resolve a relative managed path ("backgrounds/foo.jpg") to an absolute path for convertFileSrc. */
export const bgResolvePath = (rel: string) =>
  apiInvoke<string>("bg_resolve_path", { rel });

/** Delete a managed background file. No-ops on non-managed (non-"backgrounds/") paths. */
export const bgDeleteManaged = (rel: string) =>
  apiInvoke<void>("bg_delete_managed", { rel });
