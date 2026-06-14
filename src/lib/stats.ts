import { Item } from "../ipc/items";
import { getTaskMeta, getProjectMeta, getAutomationMeta } from "./meta";
import { NAV, NavGroup, NavItem } from "./typeMeta";

// WStats is a PROJECTION, not an entity. Every number is derived from the items[]
// currently in ItemStore. No rows, no item_type, no IPC, no persistence, no fallback.

export interface StatCard { label: string; value: number; icon: string; color: string; }

export interface StatsProjection {
  counts: {
    activeTasks: number; completedTasks: number; projects: number; habits: number;
    notes: number; bookmarks: number; files: number; library: number; calendar: number; total: number;
  };
  cards: StatCard[];
  series: number[];      // items created per day, last 7 days (oldest → newest)
  seriesDays: string[];  // matching day labels ("Mon"…)
  seriesMax: number;     // peak in series (0 when empty)
  hasSeries: boolean;    // false when no item has a usable created_at in the window
}

// SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC.
function parseCreatedAt(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s.replace(" ", "T") + "Z");
  if (!isNaN(d.getTime())) return d;
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function buildStats(items: Item[]): StatsProjection {
  const by = (t: string) => items.filter((i) => i.item_type === t);
  const tasks = by("task");
  const completedTasks = tasks.filter((t) => getTaskMeta(t).done).length;

  const counts = {
    activeTasks: tasks.length - completedTasks,
    completedTasks,
    projects: by("project").length,
    habits: by("habit").length,
    notes: by("note").length,
    bookmarks: by("bookmark").length,
    files: by("file").length,
    library: by("library").length,
    calendar: by("calendar").length,
    total: items.length,
  };

  const cards: StatCard[] = [
    { label: "active tasks", value: counts.activeTasks, icon: "ph-check-circle", color: "var(--h-tasks)" },
    { label: "completed", value: counts.completedTasks, icon: "ph-check-square", color: "var(--h-habits)" },
    { label: "projects", value: counts.projects, icon: "ph-kanban", color: "var(--h-projects)" },
    { label: "habits", value: counts.habits, icon: "ph-pulse", color: "var(--h-habits)" },
    { label: "notes", value: counts.notes, icon: "ph-note", color: "var(--h-notes)" },
    { label: "library", value: counts.library, icon: "ph-stack", color: "var(--h-library)" },
    { label: "files", value: counts.files, icon: "ph-file", color: "var(--h-files)" },
    { label: "bookmarks", value: counts.bookmarks, icon: "ph-bookmark-simple", color: "var(--h-bookmarks)" },
  ];

  // Trend: count items created on each of the last 7 calendar days (local).
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const series = [0, 0, 0, 0, 0, 0, 0];
  const seriesDays: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfToday);
    d.setDate(startOfToday.getDate() - (6 - i));
    seriesDays.push(DAY[d.getDay()]);
  }
  for (const it of items) {
    const d = parseCreatedAt(it.created_at);
    if (!d) continue;
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((startOfToday.getTime() - dayStart.getTime()) / 86400000);
    if (diffDays >= 0 && diffDays <= 6) series[6 - diffDays]++;
  }
  const seriesMax = Math.max(...series);

  return { counts, cards, series, seriesDays, seriesMax, hasSeries: seriesMax > 0 };
}

// ── Sidebar nav projection ──────────────────────────────────────────────────────
// Layout comes from NAV (static config); every badge number is derived from the live
// SQLite items[]. No hardcoded counts — the sidebar updates the moment the DB changes.
export interface NavItemLive extends NavItem { badgeValue?: number; }
export interface NavGroupLive { group: string; items: NavItemLive[]; }

export function buildNav(items: Item[]): NavGroupLive[] {
  const by = (t: string) => items.filter((i) => i.item_type === t);
  const openTasks = by("task").filter((t) => !getTaskMeta(t).done).length;
  const activeProjects = by("project").filter((p) => getProjectMeta(p).status === "Active").length;
  const activeAutomations = by("automation").filter((a) => getAutomationMeta(a).on).length;
  const hasCalendar = by("calendar").length > 0;

  const badgeFor: Record<string, number> = {
    notes: by("note").length,
    library: by("library").length,
    bookmarks: by("bookmark").length,
    files: by("file").length,
    openTasks,
    activeProjects,
    activeAutomations,
  };

  return NAV.map((g: NavGroup): NavGroupLive => ({
    group: g.group,
    items: g.items.map((it): NavItemLive => ({
      ...it,
      badgeValue: it.badge ? badgeFor[it.badge] : undefined,
      // Calendar presence dot lights only when there are real events.
      dot: it.id === "calendar" ? hasCalendar : it.dot,
    })),
  }));
}
