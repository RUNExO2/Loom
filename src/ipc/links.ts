import { apiInvoke } from "./index";

export interface Link {
  source_id: string;
  target_id: string;
  relationship_type: string;
  created_at: string;
}

export const getLinks = (itemId: string) => apiInvoke<Link[]>("get_links", { itemId });
// Phase 7: every live edge in a workspace in ONE call (replaces the per-item N+1 fan-out).
export const getAllLinks = (workspaceId: string) => apiInvoke<Link[]>("get_all_links", { workspaceId });
export const createLink = (sourceId: string, targetId: string, relationshipType: string) =>
  apiInvoke<Link>("create_link", { sourceId, targetId, relationshipType });
export const deleteLink = (sourceId: string, targetId: string, relationshipType: string) =>
  apiInvoke<{ id: string }>("delete_link", { sourceId, targetId, relationshipType });
