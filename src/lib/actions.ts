import { createContext, useContext } from "react";
import { Item } from "../ipc/items";

// ── Action layer ─────────────────────────────────────────────────────────────────
// One canonical, typed registry of app actions. The SAME Action is invoked from the
// command palette, keyboard shortcuts, and (future) the automation engine — one
// definition, one dispatch path, so the app is command-driven, not click-driven.
//
// An Action carries intent; its `run` closes over the app's REAL mutators and
// navigation (no fake side effects, no toast-only stubs). Actions are pure data +
// a closure — `buildActions` is unit-testable with mock deps.

export type ActionSection = "Create" | "General" | "Workspace" | "Layout";

export interface Action {
  id: string;
  title: string;
  icon: string;
  color: string;
  section: ActionSection;
  keywords?: string;       // extra search terms for the palette
  run: () => void | Promise<void>;
}

// Everything an action might need, injected once by the screen that owns these.
export interface ActionDeps {
  create: (type: string, title: string, meta?: any) => Promise<Item>;
  navigate: (view: string) => void;
  inspect: (id: string) => void;
  toast: (msg: string, icon?: string) => void;
  editDash: () => void;
  showShortcuts: () => void;
  toggleTheme: () => void;
  openThemeStudio?: () => void;
  setNavStyle?: (style: "sidebar" | "top-pill") => void;
  setDensity?: (mode: import("./settings").DensityMode) => void;
}

// The create→navigate→inspect→toast sequence every "new X" action shares: a real
// SQLite row is written, then opened for editing.
function opened(d: ActionDeps, view: string, item: Item, msg: string, icon: string) {
  d.navigate(view);
  d.inspect(item.id);
  d.toast(msg, icon);
}
function todayISO(): string {
  const x = new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

export function buildActions(d: ActionDeps): Action[] {
  return [
    {
      id: "cmd-new-note", title: "New Note", icon: "ph-note-pencil", color: "var(--h-notes)",
      section: "Create", keywords: "create note write",
      run: async () => {
        const it = await d.create("note", "Untitled note", { preview: "", folder: "Unfiled", updated: "Just now", words: 0, tag: "", body: [] });
        opened(d, "notes", it, "Note created", "ph-note-pencil");
      },
    },
    {
      id: "cmd-new-task", title: "New Task", icon: "ph-plus-circle", color: "var(--h-tasks)",
      section: "Create", keywords: "create task todo",
      run: async () => {
        const it = await d.create("task", "New task", { done: false, priority: "med", dueDate: todayISO(), due: "Today", project: "Inbox", subtasks: [] });
        opened(d, "tasks", it, "Task created", "ph-check-circle");
      },
    },
    {
      id: "cmd-new-project", title: "New Project", icon: "ph-kanban", color: "var(--h-projects)",
      section: "Create", keywords: "create project",
      run: async () => {
        const it = await d.create("project", "New project", { subtitle: "", status: "Active", progress: 0, color: "var(--h-projects)", icon: "ph-kanban", tag: "", desc: "", meta: { commits: 0, lang: "—" }, milestones: [] });
        opened(d, "projects", it, "Project created", "ph-kanban");
      },
    },
    {
      id: "cmd-new-habit", title: "New Habit", icon: "ph-pulse", color: "var(--h-habits)",
      section: "Create", keywords: "create habit streak",
      run: async () => {
        const it = await d.create("habit", "New habit", { goal: "Daily", streak: 0, color: "var(--h-habits)", week: [0, 0, 0, 0, 0, 0, 0], duration: 30, bestStreak: 0, totalDone: 0, paused: false, startDate: new Date().toISOString() });
        opened(d, "habits", it, "Habit created", "ph-pulse");
      },
    },
    {
      id: "cmd-new-bookmark", title: "New Bookmark", icon: "ph-bookmark-simple", color: "var(--h-bookmarks)",
      section: "Create", keywords: "create bookmark link url",
      run: async () => {
        const it = await d.create("bookmark", "New bookmark", { url: "https://", createdAt: new Date().toISOString(), tags: [] });
        opened(d, "bookmarks", it, "Bookmark created", "ph-bookmark-simple");
      },
    },
    {
      id: "cmd-new-event", title: "New Event", icon: "ph-calendar-plus", color: "var(--h-calendar)",
      section: "Create", keywords: "create event calendar schedule",
      run: async () => {
        const s = new Date();
        const e = new Date(s.getTime() + 3600000);
        const it = await d.create("calendar", "New event", { startDate: s.toISOString(), endDate: e.toISOString(), allDay: false, description: "", location: "", tags: "", sub: "Event · 1h", color: "var(--h-calendar)" });
        opened(d, "calendar", it, "Event created", "ph-calendar-plus");
      },
    },
    {
      id: "cmd-capture", title: "Quick Capture", icon: "ph-lightning", color: "var(--accent)",
      section: "General", keywords: "capture quick inbox",
      run: () => { d.navigate("dashboard"); d.toast("Quick Capture ready", "ph-lightning"); },
    },
    {
      id: "cmd-edit-dash", title: "Customize Dashboard", icon: "ph-squares-four", color: "var(--h-dashboard)",
      section: "General", keywords: "dashboard customize edit widgets layout",
      run: () => { d.navigate("dashboard"); d.editDash(); },
    },
    {
      id: "cmd-timeline", title: "Open Timeline", icon: "ph-clock-counter-clockwise", color: "var(--h-timeline)",
      section: "General", keywords: "timeline history activity",
      run: () => d.navigate("timeline"),
    },
    {
      id: "cmd-theme", title: "Toggle Theme", icon: "ph-moon-stars", color: "var(--text-faint)",
      section: "General", keywords: "theme dark light mode",
      run: () => d.toggleTheme(),
    },
    {
      id: "cmd-shortcuts", title: "Keyboard Shortcuts", icon: "ph-keyboard", color: "var(--text-faint)",
      section: "General", keywords: "shortcuts keys help bindings",
      run: () => d.showShortcuts(),
    },
    {
      id: "cmd-theme-studio", title: "Open Theme Studio", icon: "ph-paint-brush-broad", color: "var(--accent)",
      section: "General", keywords: "theme studio customize colors tokens palette font background",
      run: () => d.openThemeStudio?.(),
    },
    // --- WORKSPACE PRESETS ---
    {
      id: "cmd-ws-focus", title: "Workspace: Focus", icon: "ph-target", color: "var(--accent)",
      section: "Workspace", keywords: "focus workspace preset productivity dense hide sidebar",
      run: () => {
        d.setNavStyle?.("top-pill");
        d.setDensity?.("dense");
        d.navigate("dashboard");
        d.toast("Focus workspace active", "ph-target");
      },
    },
    {
      id: "cmd-ws-research", title: "Workspace: Research", icon: "ph-flask", color: "var(--h-bookmarks)",
      section: "Workspace", keywords: "research bookmarks library notes split",
      run: () => {
        d.setNavStyle?.("sidebar");
        d.setDensity?.("comfortable");
        d.navigate("bookmarks");
        d.toast("Research workspace active", "ph-flask");
      },
    },
    {
      id: "cmd-ws-planning", title: "Workspace: Planning", icon: "ph-kanban", color: "var(--h-projects)",
      section: "Workspace", keywords: "planning projects tasks compact",
      run: () => {
        d.setNavStyle?.("sidebar");
        d.setDensity?.("compact");
        d.navigate("projects");
        d.toast("Planning workspace active", "ph-kanban");
      },
    },
    {
      id: "cmd-ws-reading", title: "Workspace: Reading", icon: "ph-book-open", color: "var(--h-library)",
      section: "Workspace", keywords: "reading books library comfortable serif",
      run: () => {
        d.setNavStyle?.("top-pill");
        d.setDensity?.("comfortable");
        d.navigate("library");
        d.toast("Reading workspace active", "ph-book-open");
      },
    },
    // --- DENSITY MODES ---
    {
      id: "cmd-density-comfortable", title: "Density: Comfortable", icon: "ph-arrows-out", color: "var(--text-faint)",
      section: "Layout", keywords: "density comfortable spacious loose",
      run: () => { d.setDensity?.("comfortable"); d.toast("Comfortable density", "ph-arrows-out"); }
    },
    {
      id: "cmd-density-compact", title: "Density: Compact", icon: "ph-arrows-in", color: "var(--text-faint)",
      section: "Layout", keywords: "density compact medium normal",
      run: () => { d.setDensity?.("compact"); d.toast("Compact density", "ph-arrows-in"); }
    },
    {
      id: "cmd-density-dense", title: "Density: Dense", icon: "ph-arrows-in-line-horizontal", color: "var(--text-faint)",
      section: "Layout", keywords: "density dense tight compact high",
      run: () => { d.setDensity?.("dense"); d.toast("Dense density", "ph-arrows-in-line-horizontal"); }
    },
  ];
}

// ── React binding ────────────────────────────────────────────────────────────────
// The owning screen builds the registry from its real deps and provides it; the
// palette, keyboard handler, and automation engine all dispatch by id through one path.
export interface ActionsApi {
  actions: Action[];
  byId: Map<string, Action>;
  dispatch: (id: string) => void | Promise<void>;
}

export function makeActionsApi(deps: ActionDeps): ActionsApi {
  const actions = buildActions(deps);
  const byId = new Map(actions.map((a) => [a.id, a]));
  return {
    actions, byId,
    dispatch: (id) => {
      const a = byId.get(id);
      if (!a) { console.warn("dispatch: unknown action", id); return; }
      return a.run();
    },
  };
}

export const ActionsCtx = createContext<ActionsApi | null>(null);
export function useActions(): ActionsApi {
  const a = useContext(ActionsCtx);
  if (!a) throw new Error("useActions must be used within an ActionsCtx.Provider");
  return a;
}
