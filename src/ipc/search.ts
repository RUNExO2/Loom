import { apiInvoke } from "./index";
import { Item } from "./items";

export const searchItems = (query: string, workspaceId: string) =>
  apiInvoke<Item[]>("search_items", { workspace_id: workspaceId, query });
