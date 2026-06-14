import { apiInvoke } from "./index";

export interface ReadableArticle {
  url: string;
  title: string;
  byline?: string | null;
  site_name?: string | null;
  html: string;
  text: string;
  word_count: number;
  excerpt: string;
}

// Reader View / Web Clipper — fetch a URL and extract a clean article server-side.
export const fetchReadableArticle = (url: string) =>
  apiInvoke<ReadableArticle>("fetch_readable_article", { url });

// File encryption at rest (AES-256-GCM). Encrypts in place, preserving the item id and
// every relationship pointing at it; returns the updated file row.
export const encryptFile = (id: string, password: string) =>
  apiInvoke<unknown>("fs_encrypt_file", { id, password });

export const decryptFile = (id: string, password: string) =>
  apiInvoke<unknown>("fs_decrypt_file", { id, password });

export const isFileEncrypted = (path: string) =>
  apiInvoke<boolean>("is_file_encrypted", { path });

export const encryptVaultValue = (plaintext: string, password: string) =>
  apiInvoke<string>("encrypt_vault_value", { plaintext, password });

export const decryptVaultValue = (ciphertextStr: string, password: string) =>
  apiInvoke<string>("decrypt_vault_value", { ciphertextStr, password });

export interface IndexResult { indexed: number; skipped: number; total: number; }

// Full-text index of text-based files into the search/DB pipeline.
export const indexTextFiles = (workspaceId: string) =>
  apiInvoke<IndexResult>("index_text_files", { workspaceId });

export interface ImportFolderResult { imported: number; skipped: number; }

// Import every supported note file under a folder (Obsidian/Notion exports).
export const importNotesFromFolder = (workspaceId: string, folder: string) =>
  apiInvoke<ImportFolderResult>("import_notes_from_folder", { workspaceId, folder });

// Custom CSS folder: reveal it, and load concatenated .css for injection at launch.
export const revealCustomCssFolder = () => apiInvoke<void>("reveal_custom_css_folder");
export const getCustomCss = () => apiInvoke<string>("get_custom_css");

// SQLite VACUUM. Returns bytes freed.
export const optimizeDatabase = () => apiInvoke<number>("optimize_database");
