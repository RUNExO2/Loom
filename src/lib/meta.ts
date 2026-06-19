import { Item } from "../ipc/items";

// Single source of metadata transforms. Modules AND Dashboard widgets import from here
// so there is exactly one parse path per item_type (no duplicate transformations).
//
// NOTE: relationships are NOT metadata. No interface here carries a `links` array —
// relationships live only in the SQLite links table and are derived via
// src/lib/relations.ts. Likewise no cached aggregate counters are stored.

export interface NoteMetadata {
  preview: string; folder: string; updated: string; words: number; tag: string; body: any[];
  path?: string; filename?: string; full_text?: string;
}
export const getNoteMeta = (item: Item): NoteMetadata => {
  try {
    return { preview: "", folder: "Unfiled", updated: "Just now", words: 0, tag: "", body: [], ...JSON.parse(item.metadata || "{}") };
  } catch (e) {
    return { preview: "", folder: "Unfiled", updated: "Just now", words: 0, tag: "", body: [] };
  }
};

export interface Subtask { id: string; text: string; done: boolean; }
export interface TaskMetadata {
  done: boolean; priority: string; due: string; project: string;
  // dueDate: ISO date string ("2026-06-20") for real scheduling/overdue logic.
  // `due` stays as a human label derived from dueDate (Today/Tomorrow/Fri/…).
  dueDate?: string; subtasks?: Subtask[]; notes?: string;
  blockedBy?: string; recurrence?: string; date?: string;
}
export const getTaskMeta = (item: Item): TaskMetadata => {
  try {
    return { done: false, priority: "med", due: "Today", project: "Inbox", subtasks: [], ...JSON.parse(item.metadata || "{}") };
  } catch (e) {
    return { done: false, priority: "med", due: "Today", project: "Inbox", subtasks: [] };
  }
};

// Turn an ISO date into a friendly relative label + overdue flag (local time).
export function dueInfo(dueDate?: string, todayDate?: Date): { label: string; overdue: boolean; soon: boolean } {
  if (!dueDate) return { label: "No date", overdue: false, soon: false };
  const d = new Date(dueDate + "T00:00:00");
  if (isNaN(d.getTime())) return { label: dueDate, overdue: false, soon: false };
  const today = todayDate ? new Date(todayDate) : new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  let label: string;
  if (diff === 0) label = "Today";
  else if (diff === 1) label = "Tomorrow";
  else if (diff === -1) label = "Yesterday";
  else if (diff < 0) label = `${-diff}d overdue`;
  else if (diff < 7) label = d.toLocaleDateString([], { weekday: "short" });
  else label = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return { label, overdue: diff < 0, soon: diff >= 0 && diff <= 2 };
}

export type MediaType = "anime" | "manga" | "manhwa" | "manhua" | "book" | "movie" | "tv" | "game";

export interface MediaProgress {
  current: number;
  total: number; // 0 if unknown
}

export interface MediaTracking {
  startedAt?: string;
  finishedAt?: string;
  lastActivityAt?: string;
}

export interface LibraryMetadata {
  mediaType: MediaType;
  status: string;
  favorite: boolean;
  coverPath?: string;
  notes: string;
  tags: string[];
  progress: MediaProgress;
  tracking: MediaTracking;
  color: string;
  icon: string;
  rating: number;      // 0 = unrated, 1–10
  queue: boolean;      // on the "Up Next" watchlist
}
export const getLibraryMeta = (item: Item): LibraryMetadata => {
  try {
    const parsed = JSON.parse(item.metadata || "{}");
    
    // Current writers store `mediaType`. `kind`/`type` are legacy keys kept only for
    // migrating pre-existing rows. Read mediaType FIRST — reading kind/type first made
    // every freshly-created item fall through to "book".
    let typeToMigrate = parsed.mediaType || parsed.kind || parsed.type || "book";
    if (!["anime", "manga", "manhwa", "manhua", "book", "movie", "tv", "game"].includes(typeToMigrate)) {
      typeToMigrate = "book";
    }

    return {
      mediaType: typeToMigrate as MediaType,
      status: parsed.status || "Planned",
      favorite: parsed.favorite || false,
      coverPath: parsed.coverPath || parsed.cover || "",
      notes: parsed.notes || parsed.description || "",
      tags: parsed.tags ? (Array.isArray(parsed.tags) ? parsed.tags : parsed.tags.split(',').filter(Boolean)) : (parsed.tag ? [parsed.tag] : []),
      progress: parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : { current: 0, total: 0 },
      tracking: parsed.tracking || {},
      color: parsed.color || "var(--h-library)",
      icon: parsed.icon || "ph-book-open",
      rating: typeof parsed.rating === "number" ? parsed.rating : 0,
      queue: parsed.queue || false,
    };
  } catch (e) {
    return {
      mediaType: "book",
      status: "Planned",
      favorite: false,
      coverPath: "",
      notes: "",
      tags: [],
      progress: { current: 0, total: 0 },
      tracking: {},
      color: "var(--h-library)",
      icon: "ph-book-open",
      rating: 0,
      queue: false,
    };
  }
};

export interface CalendarMetadata {
  startDate: string; endDate: string; allDay: boolean; description: string; location: string; tags: string; sub: string; color: string;
}
export const getCalendarMeta = (item: Item): CalendarMetadata => {
  try {
    return {
      startDate: new Date().toISOString(), endDate: new Date(Date.now() + 3600000).toISOString(), allDay: false,
      description: "", location: "", tags: "", sub: "", color: "var(--h-calendar)",
      ...JSON.parse(item.metadata || "{}"),
    };
  } catch (e) {
    return { startDate: new Date().toISOString(), endDate: new Date(Date.now() + 3600000).toISOString(), allDay: false, description: "", location: "", tags: "", sub: "", color: "var(--h-calendar)" };
  }
};

// Internal bookmarks point at another LOOM entity via targetId (url stays empty);
// web bookmarks carry a url. Both render in the Bookmarks module.
export interface BookmarkMetadata { url: string; createdAt: string; tags?: string[]; targetId?: string; targetType?: string; }
export const getBookmarkMeta = (item: Item): BookmarkMetadata => {
  try {
    return { url: "", createdAt: new Date().toISOString(), ...JSON.parse(item.metadata || "{}") };
  } catch (e) {
    return { url: "", createdAt: new Date().toISOString() };
  }
};

export interface Milestone { id: string; text: string; done: boolean; }
export interface ProjectMeta {
  subtitle: string; status: string; progress: number; color: string; icon: string; tag: string; desc: string;
  // `meta` holds only PRIMITIVE descriptive attributes that aren't derivable from
  // any entity (commit count from an external repo, primary language). Aggregates
  // that ARE derivable (tasks/openTasks/notes/files) are computed in relations.ts.
  meta: { commits: number; lang: string };
  milestones: Milestone[];
}
export const getProjectMeta = (item: Item): ProjectMeta => {
  const fallback: ProjectMeta = {
    subtitle: "", status: "Active", progress: 0, color: "var(--h-projects)", icon: "ph-kanban", tag: "", desc: "",
    meta: { commits: 0, lang: "—" }, milestones: [],
  };
  try {
    const p = JSON.parse(item.metadata || "{}");
    return { ...fallback, ...p, meta: { ...fallback.meta, ...(p.meta || {}) }, milestones: Array.isArray(p.milestones) ? p.milestones : [] };
  } catch (e) { return fallback; }
};

export interface HabitMetadata {
  goal: string; streak: number; color: string; week: number[];
  // duration: the challenge length in days (7/14/30/66/90…). bestStreak/totalDone
  // are lifetime counters maintained by toggleToday in the Habits module.
  duration: number; bestStreak: number; totalDone: number; startDate?: string;
  paused: boolean;
}
const HABIT_FALLBACK: HabitMetadata = {
  goal: "Daily", streak: 0, color: "var(--h-habits)", week: [0, 0, 0, 0, 0, 0, 0],
  duration: 7, bestStreak: 0, totalDone: 0, paused: false,
};
export const getHabitMeta = (item: Item): HabitMetadata => {
  try {
    const m = { ...HABIT_FALLBACK, ...JSON.parse(item.metadata || "{}") };
    m.bestStreak = Math.max(m.bestStreak || 0, m.streak || 0);
    return m;
  } catch (e) {
    return { ...HABIT_FALLBACK };
  }
};

export interface FileMetadata {
  folder: string; ext: string; size: string; updated: string; color: string; icon: string; path: string; filename: string;
}
export const getFileMeta = (item: Item): FileMetadata => {
  try {
    return { folder: "Unfiled", ext: "—", size: "—", updated: "Just now", color: "var(--h-files)", icon: "ph-file", path: "", filename: "", ...JSON.parse(item.metadata || "{}") };
  } catch (e) {
    return { folder: "Unfiled", ext: "—", size: "—", updated: "Just now", color: "var(--h-files)", icon: "ph-file", path: "", filename: "" };
  }
};

export interface VaultMetadata {
  kind: string; icon: string; color: string; updated: string;
  // The credential value, stored ENCRYPTED (encryptVaultValue). Optional: secure-note
  // rows may carry none. Decryption happens only behind vaultSession in the UI.
  secret?: string;
}
export const getVaultMeta = (item: Item): VaultMetadata => {
  try {
    return { kind: "Secure note", icon: "ph-shield-check", color: "var(--h-vault)", updated: "", ...JSON.parse(item.metadata || "{}") };
  } catch (e) {
    return { kind: "Secure note", icon: "ph-shield-check", color: "var(--h-vault)", updated: "" };
  }
};

export interface AutomationChainNode { l: string; t: string; i: string; }
export interface AutomationMetadata {
  on: boolean; runs: number; color: string; desc: string; chain: AutomationChainNode[];
  lastRun?: string;
  // Executable rule (consumed by the Rust engine). Optional → legacy automations
  // (no trigger/actions) still parse and display; they just never fire.
  trigger?: import("../ipc/automation").RuleTrigger;
  conditions?: import("../ipc/automation").ConditionGroup | null;
  actions?: import("../ipc/automation").RuleAction[];
}
const AUTO_DEFAULTS: AutomationMetadata = { on: false, runs: 0, color: "var(--h-automation)", desc: "", chain: [] };
export const getAutomationMeta = (item: Item): AutomationMetadata => {
  try {
    return { ...AUTO_DEFAULTS, ...JSON.parse(item.metadata || "{}") };
  } catch (e) {
    return { ...AUTO_DEFAULTS };
  }
};

// Derive the cosmetic chain (When/Then nodes) from the executable rule, so the
// flow-card visual always reflects the real trigger + actions — no drift.
export const deriveChain = (m: AutomationMetadata): AutomationChainNode[] => {
  const nodes: AutomationChainNode[] = [];
  const t = m.trigger;
  if (t) {
    const label =
      t.type === "event" ? (t.event || "Event") + (t.entityType ? ` (${t.entityType})` : "")
      : t.type === "interval" ? `Every ${Math.round((t.intervalSecs || 0) / 60)} min`
      : t.type === "daily" ? `Daily at ${t.time || "—"}`
      : "Manual";
    nodes.push({ l: "When", t: label, i: t.type === "event" ? "ph-flag" : t.type === "manual" ? "ph-hand-tap" : "ph-clock" });
  }
  for (const a of m.actions || []) {
    const at: any = a;
    const txt =
      at.title ? at.title :
      at.message ? at.message :
      at.target ? `${at.type} → ${String(at.target).replace("$event.entityId", "trigger entity")}` :
      at.type;
    nodes.push({ l: "Then", t: txt, i: "ph-arrow-right" });
  }
  return nodes.length ? nodes : m.chain;
};
