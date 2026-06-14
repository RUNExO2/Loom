import { Item } from "../ipc/items";

// Timeline is a PROJECTION, not an entity. It derives chronological events purely from
// existing SQLite items (created_at + item_type + metadata). No rows, no item_type, no IPC.

export interface TimelineEvent {
  id: string;        // the real item id — clicking inspects the source entity
  kind: string;      // item_type
  title: string;
  sub: string;
  icon: string;
  color: string;
  ts: number;        // epoch ms from created_at
  when: string;      // "Today · 14:05" or "Jun 4"
  month: string;     // "June 2026"
}

const TYPE_META: Record<string, { label: string; icon: string; color: string }> = {
  task: { label: "Task", icon: "ph-check-square", color: "var(--h-tasks)" },
  note: { label: "Note", icon: "ph-note", color: "var(--h-notes)" },
  library: { label: "Library", icon: "ph-stack", color: "var(--h-library)" },
  calendar: { label: "Event", icon: "ph-calendar-dots", color: "var(--h-calendar)" },
  project: { label: "Project", icon: "ph-kanban", color: "var(--h-projects)" },
  habit: { label: "Habit", icon: "ph-pulse", color: "var(--h-habits)" },
  file: { label: "File", icon: "ph-file", color: "var(--h-files)" },
  bookmark: { label: "Bookmark", icon: "ph-bookmark-simple", color: "var(--h-bookmarks)" },
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC.
function parseCreatedAt(s: string): Date {
  if (!s) return new Date();
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? new Date(s) : d;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function subFor(type: string, meta: any): string {
  switch (type) {
    case "task": return meta.done ? "Completed" : `Open · ${meta.due || "Today"}`;
    case "library": return `${meta.progress ?? 0}% · ${meta.status || "Reading"}`;
    case "project": return `${meta.status || "Active"} · ${meta.progress ?? 0}%`;
    case "habit": return `${meta.streak ?? 0}-day streak`;
    case "note": return meta.folder || "Note";
    case "calendar": return meta.sub || "Event";
    case "file": return [meta.ext, meta.folder].filter(Boolean).join(" · ") || "File";
    case "bookmark": return meta.url || "Bookmark";
    default: return type;
  }
}

export function buildTimeline(items: Item[]): TimelineEvent[] {
  const now = new Date();
  return items
    .map((it): TimelineEvent => {
      let meta: any = {};
      try { meta = JSON.parse(it.metadata || "{}"); } catch (e) { /* keep {} */ }
      const tm = TYPE_META[it.item_type] || { label: it.item_type, icon: "ph-circle", color: "var(--text-faint)" };
      const d = parseCreatedAt(it.created_at);
      const hh = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
      return {
        id: it.id,
        kind: it.item_type,
        title: it.title,
        sub: subFor(it.item_type, meta),
        icon: meta.icon || tm.icon,
        color: meta.color || tm.color,
        ts: d.getTime(),
        when: sameDay(d, now) ? `Today · ${hh}` : `${SHORT[d.getMonth()]} ${d.getDate()}`,
        month: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
      };
    })
    .sort((a, b) => b.ts - a.ts);
}

export const TIMELINE_KINDS: [string, string, string][] = [
  ["all", "All", "ph-stack"],
  ["task", "Tasks", "ph-check-square"],
  ["note", "Notes", "ph-note"],
  ["library", "Library", "ph-stack"],
  ["project", "Projects", "ph-kanban"],
  ["habit", "Habits", "ph-pulse"],
  ["calendar", "Events", "ph-calendar-dots"],
  ["file", "Files", "ph-file"],
  ["bookmark", "Bookmarks", "ph-bookmark-simple"],
];
