import { Item } from "../ipc/items";
import { Link } from "../ipc/links";
import {
  getTaskMeta,
  dueInfo,
  getProjectMeta,
  getCalendarMeta,
  getHabitMeta,
  getLibraryMeta,
  getFileMeta
} from "./meta";
import { buildAdjacency, indexById, linkCount } from "./relations";

export interface TaskProjectionItem {
  item: Item;
  meta: ReturnType<typeof getTaskMeta>;
  di: ReturnType<typeof dueInfo>;
  linkCount: number;
}

export function getTasksProjection(tasks: Item[], links: Link[], allItems: Item[], expanded?: boolean): TaskProjectionItem[] {
  // Phase 7: build the adjacency + item index ONCE instead of re-scanning links per task.
  const adj = buildAdjacency(links);
  const byId = indexById(allItems);
  return tasks
    .map((t) => ({
      item: t,
      meta: getTaskMeta(t),
      di: dueInfo(getTaskMeta(t).dueDate),
      linkCount: linkCount(adj, byId, t.id)
    }))
    .filter(({ meta, di }) => expanded || (!meta.done && (di.label === "Today" || di.overdue)));
}

export interface ProjectProjectionItem {
  item: Item;
  meta: ReturnType<typeof getProjectMeta>;
}

export function getProjectsProjection(projects: Item[], expanded?: boolean): ProjectProjectionItem[] {
  return projects
    .map((it) => ({ item: it, meta: getProjectMeta(it) }))
    .filter(({ meta }) => expanded || meta.status === "Active");
}

export function getNotesProjection(notes: Item[], expanded?: boolean): Item[] {
  return expanded ? notes : notes.slice(0, 4);
}

export interface CalendarProjectionItem {
  id: string;
  title: string;
  time: string;
  ts: number;
  sub: string;
  color: string;
}

export function getCalendarProjection(calendarItems: Item[]): CalendarProjectionItem[] {
  return calendarItems
    .map((it) => {
      const meta = getCalendarMeta(it);
      const start = new Date(meta.startDate);
      const time = `${start.getHours().toString().padStart(2, "0")}:${start.getMinutes().toString().padStart(2, "0")}`;
      return { id: it.id, title: it.title, time, ts: start.getTime(), sub: meta.sub, color: meta.color };
    })
    .sort((a, b) => a.ts - b.ts);
}

export interface HabitProjectionItem {
  item: Item;
  meta: ReturnType<typeof getHabitMeta>;
}

export function getHabitsProjection(habits: Item[], expanded?: boolean): HabitProjectionItem[] {
  const sliced = expanded ? habits : habits.slice(0, 5);
  return sliced.map((it) => ({ item: it, meta: getHabitMeta(it) }));
}

export interface LibraryProjectionItem {
  item: Item;
  meta: ReturnType<typeof getLibraryMeta>;
}

export function getReadingProjection(libraryItems: Item[], expanded?: boolean): LibraryProjectionItem[] {
  const all = libraryItems
    .map((it) => ({ item: it, meta: getLibraryMeta(it) }))
    .filter(({ meta }) => meta.status === "Reading");
  return expanded ? all : all.slice(0, 3);
}

export function getWatchingProjection(libraryItems: Item[], expanded?: boolean): LibraryProjectionItem[] {
  const all = libraryItems
    .map((it) => ({ item: it, meta: getLibraryMeta(it) }))
    .filter(({ meta }) => meta.status === "Watching" || meta.status === "Playing");
  return expanded ? all : all.slice(0, 3);
}

export interface FileProjectionItem {
  item: Item;
  meta: ReturnType<typeof getFileMeta>;
}

export function getFilesProjection(files: Item[], expanded?: boolean): FileProjectionItem[] {
  const sliced = expanded ? files : files.slice(0, 5);
  return sliced.map((it) => ({ item: it, meta: getFileMeta(it) }));
}

export function getInboxProjection(items: Item[]): Item[] {
  return items.filter(i => {
    if (i.title.toLowerCase().includes("inbox")) return true;
    try {
      const meta = JSON.parse(i.metadata || "{}");
      if (meta.project && meta.project.toLowerCase().includes("inbox")) return true;
      if (meta.tags && Array.isArray(meta.tags) && meta.tags.some((t: string) => t.toLowerCase() === "inbox")) return true;
      if (meta.tags && typeof meta.tags === "string" && meta.tags.toLowerCase().includes("inbox")) return true;
    } catch {
      // ignore
    }
    return false;
  });
}
