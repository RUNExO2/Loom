import { apiInvoke } from "./index";

// Mirrors the Rust automation engine. SQLite is the truth; these are thin IPC
// bindings — no logic, no caching, no fake state.

export interface ExecutionRow {
  id: string;
  automation_id: string;
  trigger_source: string;
  status: "RUNNING" | "SUCCESS" | "FAILED" | "PARTIAL" | "SKIPPED";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  actions_executed: number;
  last_completed_index: number; // index of last committed action; -1 if none
  output: string | null; // JSON array of per-action log objects
  error: string | null;
}

export interface AutomationStats {
  total_executions: number;
  success: number;
  failed: number;
  partial: number;
  skipped: number;
  running: number;
  avg_duration_ms: number;
  success_rate: number;
  last_execution: string | null;
}

export const runAutomationNow = (id: string) =>
  apiInvoke<string>("run_automation_now", { id });

export const getAutomationExecutions = (automationId?: string, limit = 100) =>
  apiInvoke<ExecutionRow[]>("get_automation_executions", { automationId: automationId ?? null, limit });

export const getAutomationStats = (automationId?: string) =>
  apiInvoke<AutomationStats>("get_automation_stats", { automationId: automationId ?? null });

export const emitEvent = (
  name: string,
  workspaceId: string,
  opts: { entityId?: string; entityType?: string; title?: string; metadata?: any } = {}
) =>
  apiInvoke<void>("emit_event", {
    name,
    workspaceId,
    entityId: opts.entityId ?? null,
    entityType: opts.entityType ?? null,
    title: opts.title ?? null,
    metadata: opts.metadata != null ? JSON.stringify(opts.metadata) : null,
  });

// ── Rule schema (stored in automation item.metadata) ──────────────────────────
export const EVENT_TYPES = [
  "EntityCreated", "EntityUpdated", "EntityDeleted", "EntityLinked", "EntityUnlinked",
  "TaskCreated", "TaskUpdated", "TaskCompleted",
  "ProjectCreated", "ProjectUpdated", "ProjectCompleted",
  "NoteCreated", "NoteUpdated",
  "HabitCreated", "HabitUpdated", "HabitCompleted",
  "BookmarkAdded", "LibraryAdded", "LibraryProgressUpdated", "LibraryCompleted",
  "FileImported",
] as const;

export const ENTITY_TYPES = ["task", "note", "project", "habit", "library", "bookmark", "file", "calendar", "vault"] as const;

export type TriggerType = "event" | "interval" | "daily" | "manual";

export interface RuleTrigger {
  type: TriggerType;
  event?: string;
  entityType?: string;
  intervalSecs?: number;
  time?: string; // "HH:MM"
}

export interface ConditionLeaf { field: string; cmp: string; value?: any; }
export interface ConditionGroup { op: "AND" | "OR" | "NOT"; rules: (ConditionGroup | ConditionLeaf)[]; }

export type RuleAction =
  | { type: "createTask" | "createNote" | "createProject"; title: string; meta?: any }
  | { type: "createItem"; itemType: string; title: string; meta?: any }
  | { type: "updateMetadata"; target: string; patch: any }
  | { type: "archiveEntity" | "deleteEntity"; target: string }
  | { type: "createLink" | "deleteLink"; source: string; target: string; rel?: string }
  | { type: "notify"; message: string }
  | { type: "delay"; ms: number }
  | { type: "enableAutomation" | "disableAutomation" | "triggerAutomation"; automationId: string }
  | { type: "stop" };

export const CMP_OPS = [
  { v: "eq", l: "equals" }, { v: "neq", l: "not equals" },
  { v: "contains", l: "contains" }, { v: "gt", l: ">" }, { v: "lt", l: "<" },
  { v: "gte", l: "≥" }, { v: "lte", l: "≤" },
  { v: "exists", l: "exists" }, { v: "notExists", l: "missing" },
  { v: "isDone", l: "is done" }, { v: "hasTag", l: "has tag" },
];

export const ACTION_TYPES = [
  { v: "createTask", l: "Create task", i: "ph-check-square" },
  { v: "createNote", l: "Create note", i: "ph-note-pencil" },
  { v: "createProject", l: "Create project", i: "ph-folder-plus" },
  { v: "updateMetadata", l: "Update metadata", i: "ph-pencil-simple" },
  { v: "archiveEntity", l: "Archive entity", i: "ph-archive" },
  { v: "deleteEntity", l: "Delete entity", i: "ph-trash" },
  { v: "createLink", l: "Create link", i: "ph-link" },
  { v: "deleteLink", l: "Delete link", i: "ph-link-break" },
  { v: "notify", l: "Send notification", i: "ph-bell" },
  { v: "delay", l: "Delay", i: "ph-hourglass" },
  { v: "triggerAutomation", l: "Trigger automation", i: "ph-arrows-split" },
  { v: "enableAutomation", l: "Enable automation", i: "ph-toggle-right" },
  { v: "disableAutomation", l: "Disable automation", i: "ph-toggle-left" },
  { v: "stop", l: "Stop execution", i: "ph-stop-circle" },
];
