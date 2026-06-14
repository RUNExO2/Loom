import { apiInvoke } from "./index";

// Returns the saved file path, or null if the user cancelled the native dialog.
export const exportData = () => apiInvoke<string | null>("export_data");
export const backupDatabase = () => apiInvoke<string | null>("backup_database");
// Returns a summary string, or null if the user cancelled the native dialog.
export const importData = () => apiInvoke<string | null>("import_data");
