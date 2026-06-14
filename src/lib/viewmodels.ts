import { createContext, useContext } from "react";
import { Item } from "../ipc/items";
import { Link } from "../ipc/links";
import {
  getTasksProjection, getProjectsProjection, getNotesProjection,
  getCalendarProjection, getHabitsProjection, getReadingProjection,
  getWatchingProjection, getFilesProjection, getInboxProjection,
  TaskProjectionItem, ProjectProjectionItem, HabitProjectionItem,
  LibraryProjectionItem, FileProjectionItem, CalendarProjectionItem,
} from "./projections";
import { buildTimeline, TimelineEvent } from "./timeline";
import { buildStats, StatsProjection } from "./stats";
import {
  getNoteMeta, NoteMetadata, getLibraryMeta, LibraryMetadata,
  getTaskMeta, dueInfo, Subtask,
  getProjectMeta, ProjectMeta, Milestone,
  getHabitMeta, HabitMetadata,
  getCalendarMeta, getBookmarkMeta, BookmarkMetadata,
  getFileMeta, FileMetadata,
  getVaultMeta, VaultMetadata,
  getAutomationMeta, AutomationMetadata, AutomationChainNode, deriveChain,
} from "./meta";
import { buildAdjacency, indexById, neighborItems, neighborIds, linkCount, projectStats, ProjectStats } from "./relations";
import { TYPE_COLOR } from "./typeMeta";
import type { Entity } from "./itemStore";
import type { AutomationStats, ExecutionRow } from "../ipc/automation";

// ── UI Projection Layer ─────────────────────────────────────────────────────────
// A ViewModel is the SINGLE assembled projection a screen renders. A screen consumes
// a VM and nothing else:  UI = f(ViewModel).
//
// Hard rules this layer enforces:
//   • no component derives meaning in render scope (counts, status, %, labels)
//   • no component reads raw store rows — only VM fields
//   • every field is computed from SQLite-backed items[]/links[] (or a backend
//     projection); the UI never invents meaning.
//
// Factories are PURE (no React) so they unit-test without a DOM. The React binding
// is a context (DashboardVMCtx) the COMPOSITE screen fills once and PROJECTION-AWARE
// widgets read — no prop-drilling, single build per screen.

export interface StoreSlice { items: Item[]; links: Link[]; now?: Date }

// ── time-of-day derivations (were computed in render scope) ──────────────────────
export function greetingFor(now: Date): string {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export interface ContextCard { icon: string; title: string; body: string }
export function contextCardFor(now: Date): ContextCard {
  const h = now.getHours();
  if (h < 12) return { icon: "ph-coffee", title: "Morning Agenda", body: "Review your tasks and prepare for the day." };
  if (h < 18) return { icon: "ph-sun", title: "Afternoon Focus", body: "Deep work block. Eliminate distractions." };
  return { icon: "ph-moon", title: "Evening Review", body: "Log your habits and plan tomorrow." };
}

// ── media progress (was computed inline per card) ────────────────────────────────
export interface MediaProgressVM { perc: number; label: string }
export function mediaProgressVM(meta: LibraryMetadata): MediaProgressVM {
  const { current, total } = meta.progress;
  const perc = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const label = total > 0 ? `${current} / ${total}` : `${current}`;
  return { perc, label };
}
export interface MediaCardVM extends LibraryProjectionItem { progress: MediaProgressVM }
const mediaCards = (list: LibraryProjectionItem[]): MediaCardVM[] =>
  list.map((m) => ({ ...m, progress: mediaProgressVM(m.meta) }));

// Notes carry their parsed meta so the widget renders folder/updated without parsing.
export interface NoteCardVM { item: Item; meta: NoteMetadata }

// ── Dashboard ViewModel ──────────────────────────────────────────────────────────
export interface DashboardVM {
  greeting: string;
  contextCard: ContextCard;
  widgetCount: number;
  stats: StatsProjection;
  tasks: TaskProjectionItem[];
  projects: ProjectProjectionItem[];
  notes: NoteCardVM[];
  agenda: CalendarProjectionItem[];
  habits: HabitProjectionItem[];
  reading: MediaCardVM[];
  watching: MediaCardVM[];
  files: FileProjectionItem[];
  inbox: Item[];
  timeline: TimelineEvent[];
}

// `expanded` sizes every collection for its render context: the collapsed dashboard
// grid builds expanded=false, a single-widget Expand modal builds expanded=true.
// All slicing lives here — widgets never slice or filter.
export function createDashboardViewModel(state: StoreSlice, expanded = false): DashboardVM {
  const { items, links } = state;
  const now = state.now ?? new Date();
  const by = (t: string) => items.filter((i) => i.item_type === t);
  const tl = buildTimeline(items);
  const inbox = getInboxProjection(items);
  return {
    greeting: greetingFor(now),
    contextCard: contextCardFor(now),
    widgetCount: 0, // filled by the screen (depends on the live layout, not items)
    stats: buildStats(items),
    tasks: getTasksProjection(by("task"), links, items, expanded),
    projects: getProjectsProjection(by("project"), expanded),
    notes: getNotesProjection(by("note"), expanded).map((n) => ({ item: n, meta: getNoteMeta(n) })),
    agenda: getCalendarProjection(by("calendar")),
    habits: getHabitsProjection(by("habit"), expanded),
    reading: mediaCards(getReadingProjection(by("library"), expanded)),
    watching: mediaCards(getWatchingProjection(by("library"), expanded)),
    files: getFilesProjection(by("file"), expanded),
    inbox: expanded ? inbox : inbox.slice(0, 4),
    timeline: expanded ? tl : tl.slice(0, 4),
  };
}

// ── Timeline ViewModel ───────────────────────────────────────────────────────────
export interface TimelineMonth { month: string; events: TimelineEvent[] }
export interface TimelineVM { events: TimelineEvent[]; months: TimelineMonth[]; count: number }
export function createTimelineViewModel(state: StoreSlice, kind: string = "all", query: string = ""): TimelineVM {
  const all = buildTimeline(state.items);
  const q = query.trim().toLowerCase();
  const events = all.filter((e) =>
    (kind === "all" || e.kind === kind) &&
    (!q || (e.title + " " + (e.sub || "")).toLowerCase().includes(q)));
  // events are sorted newest→oldest, so same-month rows are already contiguous.
  const months: TimelineMonth[] = [];
  for (const e of events) {
    const last = months[months.length - 1];
    if (last && last.month === e.month) last.events.push(e);
    else months.push({ month: e.month, events: [e] });
  }
  return { events, months, count: events.length };
}

// ── Inbox ViewModel ──────────────────────────────────────────────────────────────
export interface InboxVM { items: Item[]; count: number; empty: boolean }
export function createInboxViewModel(state: StoreSlice): InboxVM {
  const items = getInboxProjection(state.items);
  return { items, count: items.length, empty: items.length === 0 };
}

// ── React binding ────────────────────────────────────────────────────────────────
// The COMPOSITE screen builds the VM once and provides it; PROJECTION-AWARE widgets
// read it. A widget rendered outside a provider is a bug, hence the throw.
export const DashboardVMCtx = createContext<DashboardVM | null>(null);
export function useDashboardVM(): DashboardVM {
  const vm = useContext(DashboardVMCtx);
  if (!vm) throw new Error("useDashboardVM must be used within a DashboardVMCtx.Provider");
  return vm;
}

// ════════════════════════════════════════════════════════════════════════════════
// Module ViewModels — one per Modules2 screen.
//
// Each factory is the screen's full read-model: every list, count, filter, grouping,
// and per-row derived field, computed once and pure. UI-state inputs the read-model
// genuinely depends on (selected grouping, priority filter, sort, calendar view) are
// factory params — not in-render branching. ACTIONS (create/edit/delete/toggle, modals,
// drag-drop, pomodoro, encryption) stay in the COMPOSITE screen; they aren't projections.
// The screen builds its VM with useMemo and renders from it — no derive-in-render.
// ════════════════════════════════════════════════════════════════════════════════

// ── Tasks ────────────────────────────────────────────────────────────────────────
export interface TaskRow {
  id: string; title: string; done: boolean; priority: string; due: string;
  dueDate?: string; overdue: boolean; project: string; subtasks: Subtask[];
  recurrence?: string; blockedBy?: string; subDone: number; subPct: number;
  color: string; linkCount: number; raw: Item;
}
export interface TasksVM {
  rows: TaskRow[]; openCount: number; overdueCount: number; projectCount: number;
  visible: TaskRow[]; groups: [string, TaskRow[]][];
}
const TASK_DUE_ORDER = ["Overdue", "Today", "This week", "Later", "No date", "Done"];
function taskBucket(t: TaskRow, now: Date): string {
  if (t.done) return "Done";
  if (!t.dueDate) return "No date";
  const d = new Date(t.dueDate + "T00:00:00");
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return "Overdue";
  if (diff === 0) return "Today";
  if (diff <= 7) return "This week";
  return "Later";
}
export function createTasksViewModel(
  state: { tasks: Item[]; links: Link[]; allItems: Item[] },
  opts: { group: string; prio: string; now?: Date },
): TasksVM {
  const now = opts.now ?? new Date();
  const adj = buildAdjacency(state.links);
  const byId = indexById(state.allItems);
  const rows: TaskRow[] = state.tasks.map((t) => {
    const meta = getTaskMeta(t);
    const di = dueInfo(meta.dueDate);
    const subs = meta.subtasks || [];
    const subDone = subs.filter((s) => s.done).length;
    return {
      id: t.id, title: t.title, done: meta.done, priority: meta.priority,
      due: di.label, dueDate: meta.dueDate, overdue: di.overdue && !meta.done,
      project: meta.project, subtasks: subs, recurrence: meta.recurrence,
      blockedBy: meta.blockedBy, subDone, subPct: subs.length ? Math.round((subDone / subs.length) * 100) : 0,
      color: "var(--h-tasks)", linkCount: linkCount(adj, byId, t.id), raw: t,
    };
  });
  const visible = rows.filter((t) => opts.prio === "all" || t.priority === opts.prio);
  const groups: [string, TaskRow[]][] =
    opts.group === "kanban"
      ? [["Todo", visible.filter((t) => !t.done)], ["Done", visible.filter((t) => t.done)]]
      : opts.group === "due"
        ? TASK_DUE_ORDER.map((label): [string, TaskRow[]] => [label, visible.filter((t) => taskBucket(t, now) === label)])
        : [...new Set(visible.map((t) => t.project))].map((p): [string, TaskRow[]] => [p, visible.filter((t) => t.project === p)]);
  return {
    rows,
    openCount: rows.filter((t) => !t.done).length,
    overdueCount: rows.filter((t) => t.overdue).length,
    projectCount: new Set(rows.map((t) => t.project)).size,
    visible, groups,
  };
}

// ── Projects ─────────────────────────────────────────────────────────────────────
export interface ProjectRow {
  item: Item; meta: ProjectMeta; stats: ProjectStats; ms: Milestone[];
  msDone: number; derivedProgress: number; health: string;
}
export interface ProjectsVM { rows: ProjectRow[]; activeCount: number; total: number; }
export function createProjectsViewModel(
  state: { projects: Item[]; links: Link[]; allItems: Item[] },
): ProjectsVM {
  const adj = buildAdjacency(state.links);
  const byId = indexById(state.allItems);
  const rows: ProjectRow[] = state.projects.map((it) => {
    const meta = getProjectMeta(it);
    const stats = projectStats(adj, byId, it.id);
    const ms = meta.milestones || [];
    const msDone = ms.filter((m) => m.done).length;
    // Progress auto-derives from milestone completion when milestones exist.
    const derivedProgress = ms.length > 0 ? Math.round((msDone / ms.length) * 100) : meta.progress;
    const health = derivedProgress >= 100 ? "Done"
      : stats.tasks > 0 && stats.openTasks / stats.tasks > 0.66 ? "At risk" : "On track";
    return { item: it, meta, stats, ms, msDone, derivedProgress, health };
  });
  return { rows, activeCount: rows.filter((r) => r.meta.status === "Active").length, total: rows.length };
}

// ── Habits ───────────────────────────────────────────────────────────────────────
export interface HabitRow { item: Item; meta: HabitMetadata; doneToday: boolean; pct: number; daysLeft: number; }
export interface HabitsVM {
  rows: HabitRow[]; longest: number; totalXP: number; level: number; xpForNext: number; xpProgress: number;
}
export function createHabitsViewModel(state: { habits: Item[] }): HabitsVM {
  const rows: HabitRow[] = state.habits.map((it) => {
    const meta = getHabitMeta(it);
    return {
      item: it, meta,
      doneToday: !!meta.week[meta.week.length - 1],
      pct: Math.min(100, Math.round((meta.streak / Math.max(1, meta.duration)) * 100)),
      daysLeft: Math.max(0, meta.duration - meta.streak),
    };
  });
  const longest = rows.length ? Math.max(...rows.map((r) => r.meta.streak)) : 0;
  const totalXP = rows.reduce((acc, h) => acc + (h.meta.totalDone || 0) * 10 + h.meta.streak * 5, 0);
  const level = Math.floor(Math.sqrt(totalXP / 50)) + 1;
  const xpForNext = Math.pow(level, 2) * 50;
  return { rows, longest, totalXP, level, xpForNext, xpProgress: Math.round((totalXP / xpForNext) * 100) };
}

// ── Calendar ─────────────────────────────────────────────────────────────────────
export interface CalEvent {
  id: string; title: string; time: string; h: number; day: number; dur: number;
  start: Date; sub: string; color: string; links: string[];
}
export interface AgendaDay { key: string; date: Date; items: CalEvent[]; }
const CAL_DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CAL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function calSameDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
export interface CalendarVM {
  today: Date; todayCol: number; weekDates: Date[]; headerTitle: string;
  events: CalEvent[]; weekBlocks: CalEvent[]; dayBlocks: CalEvent[];
  monthCells: (Date | null)[]; agenda: AgendaDay[]; unscheduledTasks: Item[];
  eventsOn: (d: Date) => CalEvent[];
}
export function createCalendarViewModel(
  state: { calendar: Item[]; links: Link[]; tasks: Item[] },
  opts: { view: "day" | "week" | "month" | "agenda"; now?: Date },
): CalendarVM {
  const today = opts.now ?? new Date();
  const dow = today.getDay();                 // 0 = Sun … 6 = Sat
  const todayCol = dow === 0 ? 6 : dow - 1;   // column in a Mon-first week
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - todayCol);
  const weekDates = Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
  const weekEnd = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);

  const headerTitle = opts.view === "month"
    ? `${CAL_MONTHS[today.getMonth()]} ${today.getFullYear()}`
    : opts.view === "day"
      ? `${CAL_DAY_NAMES[todayCol]} ${CAL_MONTHS[today.getMonth()]} ${today.getDate()} · Today`
      : `${CAL_MONTHS[today.getMonth()]} ${today.getFullYear()} · This week`;

  const sorted = [...state.calendar].sort((a, b) =>
    new Date(getCalendarMeta(a).startDate).getTime() - new Date(getCalendarMeta(b).startDate).getTime());
  const adj = buildAdjacency(state.links);
  const events: CalEvent[] = sorted.map((item) => {
    const meta = getCalendarMeta(item);
    const start = new Date(meta.startDate);
    const end = new Date(meta.endDate);
    const dayIndex = start.getDay();
    return {
      id: item.id, title: item.title,
      time: `${start.getHours().toString().padStart(2, "0")}:${start.getMinutes().toString().padStart(2, "0")}`,
      h: start.getHours(), day: dayIndex === 0 ? 6 : dayIndex - 1,
      dur: (end.getTime() - start.getTime()) / 3600000, start, sub: meta.sub, color: meta.color,
      links: neighborIds(adj, item.id),
    };
  });

  const weekBlocks = events.filter((b) => b.start >= monday && b.start < weekEnd);
  const dayBlocks = events.filter((b) => calSameDate(b.start, today));

  const monthFirst = new Date(today.getFullYear(), today.getMonth(), 1);
  const leadBlanks = (monthFirst.getDay() + 6) % 7;
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const monthCells: (Date | null)[] = [
    ...Array.from({ length: leadBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(today.getFullYear(), today.getMonth(), i + 1)),
  ];
  const eventsOn = (d: Date) => events.filter((e) => calSameDate(e.start, d));

  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const agenda: AgendaDay[] = [];
  for (const e of events.filter((e) => e.start.getTime() >= startOfToday)) {
    const key = e.start.toDateString();
    const g = agenda.find((x) => x.key === key);
    if (g) g.items.push(e); else agenda.push({ key, date: e.start, items: [e] });
  }

  const unscheduledTasks = state.tasks.filter((t) => !getTaskMeta(t).date);

  return { today, todayCol, weekDates, headerTitle, events, weekBlocks, dayBlocks, monthCells, agenda, unscheduledTasks, eventsOn };
}

// ── Bookmarks ────────────────────────────────────────────────────────────────────
export interface BookmarkCard {
  item: Item; meta: BookmarkMetadata; isInternal: boolean; target: Entity | undefined; mod: string;
}
export interface BookmarksVM { cards: BookmarkCard[]; total: number; }
export function createBookmarksViewModel(
  state: { bookmarks: Item[]; resolve: (id: string) => Entity | undefined },
  opts: { kind: "all" | "web" | "app" },
): BookmarksVM {
  const cards: BookmarkCard[] = state.bookmarks
    .filter((b) => {
      const m = getBookmarkMeta(b);
      return opts.kind === "all" || (opts.kind === "app" ? !!m.targetId : !m.targetId);
    })
    .map((b) => {
      const meta = getBookmarkMeta(b);
      const isInternal = !!meta.targetId;
      const target = isInternal ? state.resolve(meta.targetId!) : undefined;
      const mod = isInternal ? (TYPE_COLOR[meta.targetType || target?.type || ""] || "var(--h-bookmarks)") : "var(--h-bookmarks)";
      return { item: b, meta, isInternal, target, mod };
    });
  return { cards, total: state.bookmarks.length };
}

// ── Files ────────────────────────────────────────────────────────────────────────
export interface FileRow { item: Item; meta: FileMetadata; }
export interface FilesVM { rows: FileRow[]; folders: string[]; total: number; }
function fileSizeToBytes(s: string): number {
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return /mb/i.test(s) ? n * 1024 : /gb/i.test(s) ? n * 1024 * 1024 : n;
}
export function createFilesViewModel(
  state: { files: Item[] },
  opts: { sortKey: "name" | "type" | "size" | "modified"; sortDir: 1 | -1 },
): FilesVM {
  const d = opts.sortDir;
  const rows: FileRow[] = state.files.map((it) => ({ item: it, meta: getFileMeta(it) })).sort((a, b) => {
    if (opts.sortKey === "name") return a.item.title.localeCompare(b.item.title) * d;
    if (opts.sortKey === "type") return (a.meta.ext || "").localeCompare(b.meta.ext || "") * d;
    if (opts.sortKey === "size") return (fileSizeToBytes(a.meta.size) - fileSizeToBytes(b.meta.size)) * d;
    return (Number(a.item.created_at || 0) - Number(b.item.created_at || 0)) * d;
  });
  const folders = [...new Set(rows.map(({ meta }) => meta.folder.split(" / ")[0]))];
  return { rows, folders, total: rows.length };
}

// ── Notes ────────────────────────────────────────────────────────────────────────
export interface NoteRow { item: Item; meta: NoteMetadata; pinned: boolean }
export interface NotesVM {
  folders: string[];
  list: NoteRow[];              // folder + search filtered, pinned-first
  total: number;
  activeNote: Item | undefined; // selection-derived editor target
  activeMeta: NoteMetadata | null;
  activeLinks: Item[];
}
export function createNotesViewModel(state: {
  notes: Item[]; links: Link[]; allItems: Item[];
  folderFilter: string; query: string; activeId: string | null;
}): NotesVM {
  const folders = [...new Set(state.notes.map((n) => getNoteMeta(n).folder))].filter(Boolean);
  const q = state.query.toLowerCase();
  const list: NoteRow[] = state.notes
    .map((item) => ({ item, meta: getNoteMeta(item) }))
    .filter(({ item, meta }) => {
      if (state.folderFilter !== "all" && meta.folder !== state.folderFilter) return false;
      if (!state.query) return true;
      return (item.title + meta.preview + (meta.full_text || "") + meta.folder + meta.tag).toLowerCase().includes(q);
    })
    .map(({ item, meta }) => ({ item, meta, pinned: !!(meta as any).pinned }))
    // Pinned float to the top; otherwise keep store order (stable sort).
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  const activeNote = state.notes.find((n) => n.id === state.activeId) || state.notes[0];
  const activeMeta = activeNote ? getNoteMeta(activeNote) : null;
  const activeLinks = activeNote
    ? neighborItems(buildAdjacency(state.links), indexById(state.allItems), activeNote.id)
    : [];
  return { folders, list, total: state.notes.length, activeNote, activeMeta, activeLinks };
}

// ── Library ──────────────────────────────────────────────────────────────────────
const LIB_UNIT_FOR: Record<string, [string, string]> = {
  anime: ["Episode", "ep"], tv: ["Episode", "ep"],
  manga: ["Chapter", "ch"], manhwa: ["Chapter", "ch"], manhua: ["Chapter", "ch"],
  book: ["Page", "pp"], game: ["Hour", "h"],
};
const libIsCountProgress = (type: string) => type !== "movie"; // movies are watched/not, not counted
const LIB_SHELVES: { t: string; f: (m: LibraryMetadata) => boolean }[] = [
  { t: "Up Next", f: (m) => m.queue },
  { t: "Reading now", f: (m) => m.status === "Reading" },
  { t: "Watching", f: (m) => m.status === "Watching" },
  { t: "Playing", f: (m) => m.status === "Playing" },
  { t: "Completed", f: (m) => m.status === "Completed" || m.status === "Watched" },
  { t: "Planned", f: (m) => m.status === "Planned" },
  { t: "Paused / Dropped", f: (m) => m.status === "Paused" || m.status === "Dropped" },
];

export interface LibraryCard {
  id: string; title: string; item: Item; meta: LibraryMetadata;
  isMovie: boolean; watched: boolean; perc: number; unit: string; progLabel: string;
}
export interface LibraryShelf { title: string; items: LibraryCard[] }
export interface LibraryVM { shelves: LibraryShelf[]; total: number; empty: boolean }

function libraryCard(item: Item, meta: LibraryMetadata): LibraryCard {
  const isMovie = !libIsCountProgress(meta.mediaType);
  const watched = meta.status === "Watched";
  const perc = isMovie
    ? (watched ? 100 : 0)
    : (meta.progress.total > 0 ? Math.min(100, Math.round((meta.progress.current / meta.progress.total) * 100)) : 0);
  const unit = (LIB_UNIT_FOR[meta.mediaType] || ["", ""])[1];
  const progLabel = isMovie
    ? (watched ? "Watched" : "Not watched")
    : (meta.progress.total > 0
      ? `${meta.progress.current} / ${meta.progress.total}${unit ? " " + unit : ""}`
      : `${meta.progress.current}${unit ? " " + unit : ""}`);
  return { id: item.id, title: item.title, item, meta, isMovie, watched, perc, unit, progLabel };
}

export function createLibraryViewModel(state: { items: Item[]; cat: string }): LibraryVM {
  const cards = state.items.map((item) => libraryCard(item, getLibraryMeta(item)));
  const inCat = (m: LibraryMetadata) => state.cat === "all" || m.mediaType === state.cat;
  // Each shelf filters independently (an item can appear in several, e.g. Up Next + Reading).
  // Empty shelves drop out so the UI renders only populated ones.
  const shelves: LibraryShelf[] = LIB_SHELVES
    .map((sh) => ({ title: sh.t, items: cards.filter((c) => sh.f(c.meta) && inCat(c.meta)) }))
    .filter((sh) => sh.items.length > 0);
  return { shelves, total: state.items.length, empty: state.items.length === 0 };
}

// ── Vault ────────────────────────────────────────────────────────────────────────
// Read-model only: extracts vault meta + live link count. It NEVER decrypts — the
// encrypted `secret` blob passes through untouched; decryption stays behind
// vaultSession in the component. No security boundary is crossed here.
export interface VaultRow { item: Item; meta: VaultMetadata; linkCount: number }
export interface VaultVM { list: VaultRow[]; total: number; empty: boolean }
export function createVaultViewModel(state: { items: Item[]; links: Link[]; allItems: Item[] }): VaultVM {
  const adj = buildAdjacency(state.links);
  const byId = indexById(state.allItems);
  const list: VaultRow[] = state.items.map((it) => ({
    item: it,
    meta: getVaultMeta(it),
    linkCount: linkCount(adj, byId, it.id),
  }));
  return { list, total: state.items.length, empty: state.items.length === 0 };
}

// ── Automation ───────────────────────────────────────────────────────────────────
export interface AutomationRow { item: Item; meta: AutomationMetadata; linked: Item[]; chain: AutomationChainNode[] }
export interface AutomationStatCard { icon: string; value: number | string; label: string; color: string }
export interface AutomationVM {
  rows: AutomationRow[]; activeCount: number; total: number; empty: boolean; statCards: AutomationStatCard[];
  options: { id: string; title: string }[];
}
export function createAutomationViewModel(state: {
  items: Item[]; links: Link[]; allItems: Item[]; stats: AutomationStats | null;
}): AutomationVM {
  const adj = buildAdjacency(state.links);
  const byId = indexById(state.allItems);
  const rows: AutomationRow[] = state.items.map((it) => {
    const meta = getAutomationMeta(it);
    return { item: it, meta, linked: neighborItems(adj, byId, it.id), chain: deriveChain(meta) };
  });
  const activeCount = rows.filter((r) => r.meta.on).length;
  const s = state.stats;
  const statCards: AutomationStatCard[] = [
    { icon: "ph-lightning", value: activeCount, label: "active rules", color: "var(--h-automation)" },
    { icon: "ph-play", value: s?.total_executions ?? 0, label: "total runs", color: "var(--h-projects)" },
    { icon: "ph-check-circle", value: s ? `${Math.round(s.success_rate * 100)}%` : "—", label: "success rate", color: "var(--h-habits)" },
    { icon: "ph-warning", value: s?.failed ?? 0, label: "failures", color: "var(--danger)" },
    { icon: "ph-timer", value: s ? `${Math.round(s.avg_duration_ms)}ms` : "—", label: "avg duration", color: "var(--h-timeline)" },
    { icon: "ph-spinner", value: s?.running ?? 0, label: "running", color: "var(--h-vault)" },
  ];
  const options = state.items.map((it) => ({ id: it.id, title: it.title }));
  return { rows, activeCount, total: state.items.length, empty: state.items.length === 0, statCards, options };
}

// Execution-history filter (pure) — keeps the status filter out of render scope.
export function filterExecutions(rows: ExecutionRow[] | null, status: string): ExecutionRow[] {
  return (rows || []).filter((r) => status === "ALL" || r.status === status);
}

// ── Graph ViewModel ──────────────────────────────────────────────────────────────
export interface GraphNodeVM {
  id: string;
  title: string;
  item_type: string;
}
export interface GraphEdgeVM {
  source: string;
  target: string;
}
export interface GraphVM {
  nodes: GraphNodeVM[];
  edges: GraphEdgeVM[];
  nodeCount: number;
  edgeCount: number;
}
export function createGraphViewModel(
  state: { items: Item[]; links: Link[] },
  typeFilter: Set<string>,
): GraphVM {
  const nodes = state.items.map((i) => ({ id: i.id, title: i.title, item_type: i.item_type }));
  const filteredNodes = nodes.filter((n) => typeFilter.has("all") || typeFilter.has(n.item_type));
  const nodeIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = state.links
    .map((l) => ({ source: l.source_id, target: l.target_id }))
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return {
    nodes: filteredNodes,
    edges: filteredEdges,
    nodeCount: filteredNodes.length,
    edgeCount: filteredEdges.length,
  };
}
