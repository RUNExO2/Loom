import { apiInvoke } from "./index";
import { Item } from "./items";

// Full-text search. `allWorkspaces` switches the backend from a single-workspace
// filter to a cross-workspace scan. Query supports advanced syntax parsed in Rust:
//   type:task,note   "exact phrase"   foo OR bar   -exclude   #tag
export const searchItems = (query: string, workspaceId: string, allWorkspaces = false) =>
  apiInvoke<Item[]>("search_items", { workspace_id: workspaceId, query, all_workspaces: allWorkspaces });

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  scope: "workspace" | "all";
  workspace_id: string | null;
  created_at: string;
}

export const getSavedSearches = (workspaceId: string) =>
  apiInvoke<SavedSearch[]>("get_saved_searches", { workspace_id: workspaceId });

export const createSavedSearch = (
  name: string,
  query: string,
  scope: "workspace" | "all",
  workspaceId: string,
) =>
  apiInvoke<SavedSearch>("create_saved_search", {
    name,
    query,
    scope,
    workspace_id: scope === "all" ? null : workspaceId,
  });

export const deleteSavedSearch = (id: string) =>
  apiInvoke<void>("delete_saved_search", { id });
