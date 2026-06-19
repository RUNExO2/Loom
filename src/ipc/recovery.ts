import { apiInvoke } from "./index";

// ── Deletion history ──────────────────────────────────────────────────────────
export interface DeletedItem {
  id: string;
  workspace_id: string;
  item_type: string;
  title: string;
  metadata: string;
  deleted_at: string | null;
}

export const getDeletionHistory = (workspaceId: string) =>
  apiInvoke<DeletedItem[]>("get_deletion_history", { workspace_id: workspaceId });

export const restoreDeletedItem = (id: string) =>
  apiInvoke<{ id: string }>("restore_deleted_item", { id });

// ── Workspace snapshots ───────────────────────────────────────────────────────
export interface SnapshotMeta {
  id: string;
  workspace_id: string;
  label: string;
  item_count: number;
  link_count: number;
  created_at: string;
}

export const createWorkspaceSnapshot = (workspaceId: string, label: string) =>
  apiInvoke<SnapshotMeta>("create_workspace_snapshot", { workspace_id: workspaceId, label });

export const getWorkspaceSnapshots = (workspaceId: string) =>
  apiInvoke<SnapshotMeta[]>("get_workspace_snapshots", { workspace_id: workspaceId });

export const deleteWorkspaceSnapshot = (id: string) =>
  apiInvoke<void>("delete_workspace_snapshot", { id });

// Destructive: re-applies the snapshot's state to the workspace. A safety snapshot of
// the current state is auto-captured first, so a rollback is itself undoable.
export const restoreWorkspaceSnapshot = (id: string) =>
  apiInvoke<SnapshotMeta>("restore_workspace_snapshot", { id });

// ── Unified activity feed ─────────────────────────────────────────────────────
export interface ActivityEntry {
  id: string;
  action: "created" | "deleted";
  item_id: string;
  kind: string;
  title: string;
  icon: string;
  color: string;
  ts: number;
  when: string;
}

export const getActivityFeed = (workspaceId: string, limit?: number) =>
  apiInvoke<ActivityEntry[]>("get_activity_feed", { workspace_id: workspaceId, limit });
