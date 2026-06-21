import { apiInvoke } from "./index";

export interface Item {
  id: string;
  workspace_id: string;
  item_type: string;
  title: string;
  created_at: string;
  updated_at: string;
  user_pinned: boolean;
  user_size_preference: string | null;
  metadata: string; // JSON string
}

export const getItems = async (workspaceId: string): Promise<Item[]> => {
  const CHUNK_SIZE = 5000;
  let offset = 0;
  const allItems: Item[] = [];
  while (true) {
    const chunk = await apiInvoke<Item[]>("get_items", { workspaceId, limit: CHUNK_SIZE, offset });
    allItems.push(...chunk);
    if (chunk.length < CHUNK_SIZE) break;
    offset += CHUNK_SIZE;
  }
  return allItems;
};
export const createItem = (workspaceId: string, title: string, itemType: string, metadata: string = "{}") =>
  apiInvoke<Item>("create_item", { workspaceId, title, itemType, metadata });
export const updateItem = (id: string, title: string, itemType: string) =>
  apiInvoke<Item>("update_item", { id, title, itemType });
export const deleteItem = (id: string) => apiInvoke<{ id: string }>("delete_item", { id });
export const updateItemIntent = (id: string, userPinned: boolean, userSizePreference: string | null) =>
  apiInvoke<Item>("update_item_intent", { id, userPinned, userSizePreference });
export const updateItemMetadata = (id: string, metadata: string) =>
  apiInvoke<Item>("update_item_metadata", { id, metadata });
export const restoreSnapshot = (item: Item, links: any[]) =>
  apiInvoke<Item>("restore_snapshot", { item, links });
export const verifyIntegrity = (id: string, expectedExistence: boolean) =>
  apiInvoke<boolean>("verify_integrity", { id, expectedExistence });

export const getSetting = (key: string) => apiInvoke<string | null>("get_setting", { key });
export const setSetting = (key: string, value: string) => apiInvoke<void>("set_setting", { key, value });
export const getTimeline = (workspaceId: string) => apiInvoke<any[]>("get_timeline", { workspaceId });
export const getStats = (workspaceId: string) => apiInvoke<any>("get_stats", { workspaceId });

export const getMutationLedger = () => apiInvoke<any[]>("get_mutation_ledger");
export const getSystemHealth = () => apiInvoke<any>("get_system_health");
export const repairIntegrity = () => apiInvoke<any>("repair_integrity");

export interface DashboardWidget {
  id: string;
  workspace_id: string;
  widget_type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hidden: boolean;
  config?: string | null;
}

export const getDashboardLayout = (workspaceId: string) =>
  apiInvoke<DashboardWidget[]>("get_dashboard_layout", { workspaceId });

export const saveDashboardLayout = (workspaceId: string, widgets: DashboardWidget[]) =>
  apiInvoke<void>("save_dashboard_layout", { workspaceId, widgets });

export interface ThemePreset {
  id: string;
  name: string;
  blurb: string;
  tokens: string; // JSON string
}

export const getThemePresets = () =>
  apiInvoke<ThemePreset[]>("get_theme_presets");

export const saveThemePreset = (preset: ThemePreset) =>
  apiInvoke<void>("save_theme_preset", { preset });

export const deleteThemePreset = (id: string) =>
  apiInvoke<void>("delete_theme_preset", { id });

export const duplicateThemePreset = (id: string, newId: string, newName: string) =>
  apiInvoke<void>("duplicate_theme_preset", { id, newId, newName });

export const renameThemePreset = (id: string, newName: string) =>
  apiInvoke<void>("rename_theme_preset", { id, newName });
