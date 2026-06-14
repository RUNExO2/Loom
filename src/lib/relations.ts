import { Item } from "../ipc/items";
import { Link } from "../ipc/links";
import { getTaskMeta } from "./meta";

// ── Relationship selectors ────────────────────────────────────────────────────
// PURE functions over an ADJACENCY index built from the SQLite `links` table (the
// ONLY truth for relationships; no relationship data lives in item metadata).
//
// Phase 7 rewrite: the old selectors took the raw `links` array and re-scanned ALL
// of it on every call — O(links) per rendered row, i.e. O(items × links) to build a
// screen. Now the caller builds the adjacency map ONCE (O(links)) and every lookup
// below is O(degree). "Orphan-free" still holds: a neighbour is only returned when
// it exists in the live item index, so a removed entity vanishes from every view.

export type Adjacency = Map<string, Set<string>>;

// Build the undirected adjacency index once. Each edge contributes both directions.
export function buildAdjacency(links: Link[]): Adjacency {
  const adj: Adjacency = new Map();
  const add = (a: string, b: string) => {
    let s = adj.get(a);
    if (!s) { s = new Set<string>(); adj.set(a, s); }
    s.add(b);
  };
  for (const l of links) {
    add(l.source_id, l.target_id);
    add(l.target_id, l.source_id);
  }
  return adj;
}

// Index items by id once for O(1) existence/lookup in the selectors below.
export function indexById(items: Item[]): Map<string, Item> {
  const m = new Map<string, Item>();
  for (const it of items) m.set(it.id, it);
  return m;
}

// Raw neighbour ids (other endpoint of each edge touching id) — O(degree).
export function neighborIds(adj: Adjacency, id: string): string[] {
  const s = adj.get(id);
  return s ? [...s] : [];
}

// Neighbours that still exist as items — no orphan references. O(degree).
export function neighborItems(adj: Adjacency, itemsById: Map<string, Item>, id: string): Item[] {
  const s = adj.get(id);
  if (!s || s.size === 0) return [];
  const out: Item[] = [];
  for (const nid of s) {
    const it = itemsById.get(nid);
    if (it) out.push(it);
  }
  return out;
}

// Number of live relationships for an item. O(degree).
export function linkCount(adj: Adjacency, itemsById: Map<string, Item>, id: string): number {
  const s = adj.get(id);
  if (!s) return 0;
  let n = 0;
  for (const nid of s) if (itemsById.has(nid)) n++;
  return n;
}

// Project aggregates, derived purely from linked entities — nothing cached in JSON.
export interface ProjectStats { tasks: number; openTasks: number; notes: number; files: number; }
export function projectStats(adj: Adjacency, itemsById: Map<string, Item>, projectId: string): ProjectStats {
  const neighbors = neighborItems(adj, itemsById, projectId);
  const tasks = neighbors.filter((i) => i.item_type === "task");
  const openTasks = tasks.filter((t) => !getTaskMeta(t).done).length;
  const notes = neighbors.filter((i) => i.item_type === "note").length;
  const files = neighbors.filter((i) => i.item_type === "file").length;
  return { tasks: tasks.length, openTasks, notes, files };
}
