/* ============================================================
   Presentation config — NOT data.
   Pure type→icon/color/label lookup tables and the static nav
   layout. Contains zero entity rows, counts, or mock content.
   Every numeric value the UI shows is derived from SQLite via
   the store + selectors; this file only maps an item_type to how
   it should look, and lists the navigation menu structure.
   ============================================================ */

// Module accent color tokens (CSS variables defined in styles/index.css).
export const MOD = {
  dashboard: "var(--h-dashboard)", notes: "var(--h-notes)", library: "var(--h-library)",
  tasks: "var(--h-tasks)", projects: "var(--h-projects)", habits: "var(--h-habits)",
  calendar: "var(--h-calendar)", vault: "var(--h-vault)", bookmarks: "var(--h-bookmarks)",
  files: "var(--h-files)", timeline: "var(--h-timeline)", automation: "var(--h-automation)",
};

export const TYPE_LABEL: Record<string, string> = {
  project: "Project", note: "Note", task: "Task", media: "Library", library: "Library",
  file: "File", bookmark: "Bookmark", habit: "Habit", vault: "Vault",
  automation: "Automation", timeline: "Timeline", calendar: "Event",
};

export const TYPE_ICON: Record<string, string> = {
  project: "ph-kanban", note: "ph-note", task: "ph-check-square", media: "ph-stack",
  library: "ph-stack", file: "ph-file", bookmark: "ph-bookmark-simple", habit: "ph-pulse",
  vault: "ph-vault", automation: "ph-lightning", timeline: "ph-clock-counter-clockwise",
  calendar: "ph-calendar-dots",
};

export const TYPE_COLOR: Record<string, string> = {
  project: MOD.projects, note: MOD.notes, task: MOD.tasks, media: MOD.library,
  library: MOD.library, file: MOD.files, bookmark: MOD.bookmarks, habit: MOD.habits,
  vault: MOD.vault, automation: MOD.automation, timeline: MOD.timeline, calendar: MOD.calendar,
};

// ── Navigation layout ───────────────────────────────────────────────────────────
// Structure only (group / id / label / icon / accent). The `badge` field names which
// live store count the sidebar should render next to the item; it carries NO number.
// Badge values are computed from SQLite items by buildNav() in lib/stats.ts.
export type NavBadge =
  | "notes" | "library" | "bookmarks" | "files" | "openTasks" | "activeProjects" | "activeAutomations";

export interface NavItem {
  id: string; label: string; icon: string; mod: string;
  badge?: NavBadge; dot?: boolean;
  // soon: module is visible but greyed out and non-navigable ("Coming soon").
  soon?: boolean;
}
export interface NavGroup { group: string; items: NavItem[]; }

export const NAV: NavGroup[] = [
  { group: "Workspace", items: [
    { id: "dashboard", label: "Dashboard", icon: "ph-squares-four", mod: MOD.dashboard },
    { id: "timeline", label: "Timeline", icon: "ph-clock-counter-clockwise", mod: MOD.timeline },
  ]},
  { group: "Knowledge", items: [
    { id: "notes", label: "Notes", icon: "ph-note", mod: MOD.notes, badge: "notes" },
    { id: "library", label: "Library", icon: "ph-stack", mod: MOD.library, badge: "library" },
    { id: "bookmarks", label: "Bookmarks", icon: "ph-bookmark-simple", mod: MOD.bookmarks, badge: "bookmarks" },
    { id: "files", label: "Files", icon: "ph-folder", mod: MOD.files, badge: "files" },
  ]},
  { group: "Execution", items: [
    { id: "tasks", label: "Tasks", icon: "ph-check-square", mod: MOD.tasks, badge: "openTasks" },
    { id: "projects", label: "Projects", icon: "ph-kanban", mod: MOD.projects, badge: "activeProjects" },
    { id: "habits", label: "Habits", icon: "ph-pulse", mod: MOD.habits },
    { id: "calendar", label: "Calendar", icon: "ph-calendar-dots", mod: MOD.calendar, dot: true },
  ]},
  { group: "System", items: [
    { id: "vault", label: "Vault", icon: "ph-vault", mod: MOD.vault },
    { id: "automation", label: "Automation", icon: "ph-lightning", mod: MOD.automation },
  ]},
];
