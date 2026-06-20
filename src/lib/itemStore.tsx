import React, { createContext, useContext, useCallback, useEffect, useMemo, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { unfreezeSystem } from "../ipc/settings";
import { getWorkspaces, createWorkspace } from "../ipc/workspaces";
import {
  getItems, createItem as ipcCreate, updateItem as ipcUpdate, updateItemMetadata as ipcUpdateMeta,
  deleteItem as ipcDelete, restoreSnapshot as ipcRestoreSnapshot, Item,
  getDashboardLayout, saveDashboardLayout, DashboardWidget
} from "../ipc/items";
import { getAllLinks, createLink, deleteLink, Link } from "../ipc/links";
import { buildAdjacency } from "./relations";
import { TYPE_ICON, TYPE_COLOR } from "./typeMeta";
import { assertNotFrozen } from "./mutationGuard";
import { vaultSession } from "./vaultSession";
// `D` (the mock dataset) is imported ONLY for the one-time empty-DB seed below.
// It is never read while rendering — the UI reads SQLite through this store.
import { D } from "../data/loomData";

// ── Authority model ───────────────────────────────────────────────────────────
// SQLite = truth. This store = the single React render cache over it.
// Modules AND Dashboard widgets read/write through here — never their own fetch.

export interface Entity {
  id: string; type: string; title: string; icon: string; color: string;
  links: string[]; desc: string; tag?: string; raw: Item; meta: any;
}

const ICON_FALLBACK: Record<string, string> = { calendar: "ph-calendar-dots", library: "ph-stack" };
const COLOR_FALLBACK: Record<string, string> = { calendar: "var(--h-calendar)", library: "var(--h-library)" };

// `links` is intentionally left empty here — relationships are NOT in metadata.
// The store fills Entity.links from the SQLite links table when it builds the
// resolve() map (see ItemStoreProvider). toEntity stays a pure per-item transform.
export function toEntity(item: Item): Entity {
  let meta: any = {};
  try { meta = JSON.parse(item.metadata || "{}"); } catch (e) { /* keep {} */ }
  const type = item.item_type;
  return {
    id: item.id, type, title: item.title,
    icon: meta.icon || TYPE_ICON[type] || ICON_FALLBACK[type] || "ph-file",
    color: meta.color || TYPE_COLOR[type] || COLOR_FALLBACK[type] || "var(--accent)",
    links: [],
    desc: meta.description || meta.preview || "",
    tag: meta.tag, raw: item, meta,
  };
}

interface ItemStoreType {
  workspaceId: string | null;
  ready: boolean;
  items: Item[];
  links: Link[];
  isVaultUnlocked: boolean;
  resolve: (id: string) => Entity | undefined;
  create: (type: string, title: string, meta?: any) => Promise<Item>;
  updateMeta: (id: string, meta: any) => Promise<Item>;
  updateFields: (id: string, title: string, type: string) => Promise<Item>;
  remove: (id: string) => Promise<void>;
  restore: (item: Item, linksToRestore: Link[]) => Promise<void>;
  link: (a: string, b: string) => Promise<void>;
  unlink: (a: string, b: string) => Promise<void>;
  refresh: () => Promise<void>;
  error: string | null;
  dashboardWidgets: DashboardWidget[];
  saveDashboard: (widgets: DashboardWidget[]) => Promise<void>;
}

// Every relationship edge uses this single relationship_type. The links table is the
// sole truth; these helpers are the ONLY runtime path that mutates it (plus the seed).
export const REL = "related";

const ItemStoreCtx = createContext<ItemStoreType | null>(null);
export const useItemStore = () => {
  const c = useContext(ItemStoreCtx);
  if (!c) throw new Error("useItemStore must be used within ItemStoreProvider");
  return c;
};

// ── One-time seed of demo content (only when the DB is genuinely empty) ─────────
// This is NOT a runtime fallback: it writes real rows once, then SQLite is sole truth.
//
// Relationships are seeded as REAL rows in the SQLite links table (createLink),
// NOT as arrays inside metadata. The seed's static ids (e.g. "p-gng") are mapped to
// the real UUIDs create_item assigns, then every seed-declared edge is materialised
// as a link row. After this, relations.ts derives all connections from those rows.
async function _seedAll(wsId: string): Promise<Item[]> {
  const out: Item[] = [];
  const idMap = new Map<string, string>();          // seed static id → real UUID
  const pending: { from: string; to: string[] }[] = []; // edges to materialise after all rows exist

  // staticId may be null for rows nothing links TO (e.g. agenda events).
  const push = async (staticId: string | null, title: string, type: string, meta: any, links?: string[]) => {
    const it = await ipcCreate(wsId, title, type, JSON.stringify(meta));
    out.push(it);
    if (staticId) idMap.set(staticId, it.id);
    if (links && links.length) pending.push({ from: it.id, to: links });
  };

  for (const n of D.notes)
    await push(n.id, n.title, "note", { preview: n.preview, folder: n.folder, updated: n.updated, words: n.words, tag: n.tag, body: n.body || [] }, n.links);

  for (const t of D.tasks)
    await push(t.id, t.title, "task", { done: t.done, priority: t.priority, due: t.due, project: t.project }, t.links);

  for (const m of D.media) {
    let progressTotal = 0;
    if (m.of && typeof m.of === "string") {
      const match = m.of.match(/(\d+)/g);
      if (match && match.length > 0) progressTotal = parseInt(match[match.length - 1], 10);
    }
    const currentProgress = progressTotal > 0 ? Math.floor((m.progress / 100) * progressTotal) : m.progress;
    
    await push(m.id, m.title, "library", { 
      mediaType: m.kind as any, 
      status: m.status, 
      favorite: false, 
      notes: "", 
      tags: m.tag ? [m.tag] : [], 
      progress: { current: currentProgress, total: progressTotal },
      tracking: {},
      color: m.color, 
      icon: m.icon
    }, (m as any).links);
  }

  // Seed agenda relative to today so events always land in the calendar's current week.
  const today = new Date();
  for (const a of D.agenda) {
    const h = parseInt(a.time);
    const dur = a.sub.includes("2h") ? 2 : 1;
    const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, 0, 0);
    const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h + dur, 0, 0);
    await push(null, a.title, "calendar", { startDate: startDate.toISOString(), endDate: endDate.toISOString(), allDay: false, description: "", location: "", tags: "", sub: a.sub, color: a.color }, (a as any).links);
  }

  for (const b of D.bookmarks)
    await push(b.id, b.title, "bookmark", { url: `https://${b.site || "example.com"}`, createdAt: new Date().toISOString(), tags: [] }, b.links);

  for (const p of D.projects)
    await push(p.id, p.title, "project", { subtitle: p.subtitle, status: p.status, progress: p.progress, color: p.color, icon: p.icon, tag: p.tag, desc: p.desc, meta: { commits: p.meta.commits, lang: p.meta.lang } }, p.links);

  for (const h of D.habits)
    await push(h.id, h.title, "habit", { goal: h.goal, streak: h.streak, color: h.color, week: h.week }, h.links);

  for (const f of D.files)
    await push(f.id, f.title, "file", { folder: f.folder, ext: f.ext, size: f.size, updated: f.updated, color: f.color, icon: f.icon }, f.links);

  for (const v of D.vault)
    await push(v.id, v.title, "vault", { kind: v.kind, icon: v.icon, color: v.color, updated: v.updated }, v.links);

  for (const a of D.automations)
    await push(a.id, a.title, "automation",
      { on: a.on, runs: a.runs, color: a.color, desc: a.desc, chain: [],
        trigger: (a as any).trigger, conditions: (a as any).conditions ?? null, actions: (a as any).actions ?? [] },
      a.links);

  // Materialise every edge as a real link row. Targets that aren't seeded as items
  // (e.g. timeline ids) are simply skipped. Undirected dedupe so each pair is one row.
  const seen = new Set<string>();
  for (const { from, to } of pending) {
    for (const targetStatic of to) {
      const target = idMap.get(targetStatic);
      if (!target || target === from) continue;
      const key = [from, target].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      await createLink(from, target, "related");
    }
  }

  return out;
}
// noUnusedLocals: _seedAll is intentionally preserved for future use.
void (null as unknown as typeof _seedAll);

// Vault + automation were added after the original seed. For DBs seeded before they
// existed, this writes the missing system rows once. Their seed relationships can't be
// materialised here (the pre-existing rows have unknown real ids), so these rows start
// unlinked — a full reset re-seeds everything with real link rows.
async function seedSystemTypes(push: (title: string, type: string, meta: any) => Promise<void>) {
  for (const v of D.vault)
    await push(v.title, "vault", { kind: v.kind, icon: v.icon, color: v.color, updated: v.updated });

  for (const a of D.automations)
    await push(a.title, "automation",
      { on: a.on, runs: a.runs, color: a.color, desc: a.desc, chain: [],
        trigger: (a as any).trigger, conditions: (a as any).conditions ?? null, actions: (a as any).actions ?? [] });
}

export function ItemStoreProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dashboardWidgets, setDashboardWidgets] = useState<DashboardWidget[]>([]);
  const [isVaultUnlocked, setIsVaultUnlocked] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      // Reconcile before reading SQLite to keep them in sync
      await fsReconcile().catch(console.error);
      const ws = await getWorkspaces();
      const wsId = ws.length === 0 ? (await createWorkspace("Default Workspace")).id : ws[0].id;
      setWorkspaceId(wsId);
      let loaded = await getItems(wsId);
      if (loaded.length === 0) {
        // Database is empty. Seeding is disabled so the app starts as a clean, blank slate.
        loaded = [];
      } else if (!loaded.some((i) => i.item_type === "vault" || i.item_type === "automation")) {
        // DB seeded before system types existed — backfill them once, then reload.
        const push = async (title: string, type: string, meta: any) => {
          await ipcCreate(wsId, title, type, JSON.stringify(meta));
        };
        await seedSystemTypes(push);
        loaded = await getItems(wsId);
      }
      setItems(loaded);
      // Phase 7: one batched IPC call for the whole workspace's edges, replacing the
      // old per-item get_links fan-out (N IPC round trips + N unindexed scans).
      setLinks(await getAllLinks(wsId));
      
      const layouts = await getDashboardLayout(wsId);
      setDashboardWidgets(layouts);
      
      setIsVaultUnlocked(vaultSession.isUnlocked());
      
      setReady(true);
      // Step 8: System is completely hydrated, safe to unfreeze backend and let background tasks run
      await unfreezeSystem().catch(console.error);
    } catch (e: any) {
      console.error("ItemStore load failed:", e);
      setError(e.message || String(e));
    }
  }, []);

  // Listen to mutation events for event-sourced state synchronization
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    
    listen<any>("loom://event", (event) => {
      if (!active) return;
      const { type, payload } = event.payload;
      switch (type) {
        case 'ITEM_CREATED': {
          setItems((prev) => {
            if (prev.some((x) => x.id === payload.id)) return prev;
            return [payload, ...prev];
          });
          break;
        }
        case 'ITEM_UPDATED': {
          setItems((prev) => prev.map((x) => (x.id === payload.id ? payload : x)));
          break;
        }
        case 'ITEM_DELETED': {
          setItems((prev) => prev.filter((x) => x.id !== payload.id));
          setLinks((prev) => prev.filter((l) => l.source_id !== payload.id && l.target_id !== payload.id));
          break;
        }
        case 'ITEM_RESTORED': {
          const { item, links: linksToRestore } = payload;
          setItems((prev) => {
            if (prev.some((x) => x.id === item.id)) return prev;
            return [item, ...prev];
          });
          if (linksToRestore && linksToRestore.length > 0) {
            setLinks((prev) => {
              const next = [...prev];
              for (const l of linksToRestore) {
                if (!next.some(x => x.source_id === l.source_id && x.target_id === l.target_id && x.relationship_type === l.relationship_type)) {
                  next.push(l);
                }
              }
              return next;
            });
          }
          break;
        }
        case 'LINK_CREATED': {
          setLinks((prev) => {
            if (prev.some((l) => l.source_id === payload.source_id && l.target_id === payload.target_id && l.relationship_type === payload.relationship_type)) return prev;
            return [...prev, payload];
          });
          break;
        }
        case 'LINK_DELETED': {
          const { source_id, target_id, relationship_type } = payload;
          setLinks((prev) => prev.filter((l) =>
            !(l.relationship_type === relationship_type &&
              ((l.source_id === source_id && l.target_id === target_id) || (l.source_id === target_id && l.target_id === source_id)))
          ));
          break;
        }
        case 'DASHBOARD_UPDATED': {
          setDashboardWidgets(payload);
          break;
        }
        case 'VAULT_UNLOCKED': {
          setIsVaultUnlocked(true);
          break;
        }
        case 'VAULT_LOCKED': {
          setIsVaultUnlocked(false);
          break;
        }
      }
    }).then((u) => {
      if (!active) {
        u();
      } else {
        unlisten = u;
      }
    });

    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    refresh().catch((e) => console.error("ItemStore load failed:", e));

    // Phase 7: previously a FULL reload (fsReconcile + getItems + getAllLinks +
    // dashboard) fired on EVERY window focus — every alt-tab/click-in rehydrated the
    // entire cache. In-app mutations are already reconciled incrementally by the
    // loom://event reducer above, and backend automation writes by
    // loom://automation-changed. So we only need to catch changes made OUTSIDE the
    // app (e.g. files dropped on disk) when the user RETURNS to a hidden window.
    // visibilitychange fires only on real tab/app switches (not focus churn), and we
    // throttle to at most one reconcile per 5s.
    let lastSync = 0;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const ts = Date.now();
      if (ts - lastSync < 5000) return;
      lastSync = ts;
      fsReconcile()
        .then(() => refresh())
        .catch((e) => console.error("FileSystem reconciliation failed:", e));
    };
    document.addEventListener("visibilitychange", onVisible);

    let active = true;
    let unlistenChanged: (() => void) | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    listen("loom://automation-changed", () => {
      if (!active) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        refresh().catch((e) => console.error("Automation refresh failed:", e));
      }, 150);
    }).then((u) => {
      if (!active) {
        u();
      } else {
        unlistenChanged = u;
      }
    }).catch(() => { /* not in a Tauri window */ });

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
      if (unlistenChanged) unlistenChanged();
      if (debounce) clearTimeout(debounce);
    };
  }, [refresh]);

  const emitLoomEvent = async (event: any) => {
    await emit("loom://event", event);
  };

  // Each mutation = an atomic Rust IPC write + a UI event emit. The Rust write is
  // transactional (E9 savepoint model), so there is no JS rollback to orchestrate:
  // a failed write commits nothing. assertNotFrozen preserves the wipe-path guard.
  const create = useCallback(async (type: string, title: string, meta?: any) => {
    if (!workspaceId) throw new Error("No workspace");
    assertNotFrozen(`Create ${type}`);
    const metaString = meta !== undefined ? JSON.stringify(meta) : "{}";
    const createdItem = await ipcCreate(workspaceId, title, type, metaString);
    await emitLoomEvent({ type: 'ITEM_CREATED', payload: createdItem });
    return createdItem;
  }, [workspaceId]);

  const updateMeta = useCallback(async (id: string, meta: any) => {
    assertNotFrozen("Update Item Metadata");
    const payload = typeof meta === "string" ? meta : JSON.stringify(meta);
    const updatedItem = await ipcUpdateMeta(id, payload);
    await emitLoomEvent({ type: 'ITEM_UPDATED', payload: updatedItem });
    return updatedItem;
  }, []);

  const updateFields = useCallback(async (id: string, title: string, type: string) => {
    assertNotFrozen("Update Item Fields");
    const updatedItem = await ipcUpdate(id, title, type);
    await emitLoomEvent({ type: 'ITEM_UPDATED', payload: updatedItem });
    return updatedItem;
  }, []);

  const remove = useCallback(async (id: string) => {
    const itemInStore = items.find(x => x.id === id);
    if (!itemInStore) return;
    assertNotFrozen("Delete Item");
    await ipcDelete(id);
    await emitLoomEvent({ type: 'ITEM_DELETED', payload: { id } });
  }, [items]);

  const restore = useCallback(async (item: Item, linksToRestore: Link[]) => {
    assertNotFrozen("Restore Snapshot");
    await ipcRestoreSnapshot(item, linksToRestore);
    await emitLoomEvent({ type: 'ITEM_RESTORED', payload: { item, links: linksToRestore } });
  }, []);

  const link = useCallback(async (a: string, b: string) => {
    if (a === b) return;
    assertNotFrozen("Create Link");
    const createdLinkRow = await createLink(a, b, REL);
    await emitLoomEvent({ type: 'LINK_CREATED', payload: createdLinkRow });
  }, []);

  const unlink = useCallback(async (a: string, b: string) => {
    assertNotFrozen("Delete Link");
    await deleteLink(a, b, REL);
    await emitLoomEvent({ type: 'LINK_DELETED', payload: { source_id: a, target_id: b, relationship_type: REL } });
  }, []);

  const map = useMemo(() => {
    // Phase 7: build the adjacency index ONCE (O(links)), then fill each entity's
    // neighbours in O(degree). Previously this called neighborIds(links, id) per
    // item — O(items × links), the quadratic that capped the cache at ~5k items.
    const adj = buildAdjacency(links);
    const m = new Map<string, Entity>();
    for (const it of items) m.set(it.id, toEntity(it));
    for (const ent of m.values()) {
      const s = adj.get(ent.id);
      ent.links = s ? [...s].filter((nid) => m.has(nid)) : [];
    }
    return m;
  }, [items, links]);
  const resolve = useCallback((id: string) => map.get(id), [map]);

  const saveDashboard = useCallback(async (widgets: DashboardWidget[]) => {
    if (!workspaceId) return;
    assertNotFrozen("Save Dashboard Layout");
    await saveDashboardLayout(workspaceId, widgets);
    await emitLoomEvent({ type: 'DASHBOARD_UPDATED', payload: widgets });
  }, [workspaceId]);

  const value: ItemStoreType = { workspaceId, ready, items, links, isVaultUnlocked, resolve, create, updateMeta, updateFields, remove, restore, link, unlink, refresh, error, dashboardWidgets, saveDashboard };
  return <ItemStoreCtx.Provider value={value}>{children}</ItemStoreCtx.Provider>;
}

// ── Typed projection hooks — modules and widgets share these exact slices ───────
export function useItemsByType(type: string): Item[] {
  const { items } = useItemStore();
  return useMemo(() => items.filter((i) => i.item_type === type), [items, type]);
}

function useTyped(type: string) {
  const store = useItemStore();
  const items = useItemsByType(type);
  const create = useCallback((title: string, meta?: any) => store.create(type, title, meta), [store, type]);
  return {
    items, create,
    links: store.links,
    updateMeta: store.updateMeta,
    updateFields: store.updateFields,
    remove: store.remove,
    restore: store.restore,
    workspaceId: store.workspaceId,
    ready: store.ready,
    error: store.error,
  };
}

export const useTasks = () => useTyped("task");
export const useLibrary = () => useTyped("library");
export const useCalendar = () => useTyped("calendar");
export const useBookmarks = () => useTyped("bookmark");
export const useProjects = () => useTyped("project");
export const useHabits = () => useTyped("habit");
export const useVault = () => useTyped("vault");
export const useAutomations = () => useTyped("automation");

import {
  fsCreateFile, fsImportFile, fsOpenFile, fsRevealInExplorer, fsDeleteFile, fsGetFiles, fsRenameFile, FileEntry,
  fsCreateNote, fsReadNoteContent, fsWriteNoteContent, fsImportNoteFile, fsReconcile
} from "../ipc/fs";

export function useFiles() {
  const store = useItemStore();
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);

  useEffect(() => {
    if (store.workspaceId && store.ready) {
      fsGetFiles(store.workspaceId)
        .then(setFileEntries)
        .catch(console.error);
    }
  }, [store.workspaceId, store.ready, store.items]); // re-fetch when items change to stay in sync

  // We convert FileEntry to something that looks like an Item so it works with global links/etc if needed.
  // Filter to show only files of type "file"
  const items = useMemo(() => {
    return fileEntries
      .filter(f => f.item_type === "file")
      .map(f => {
        const folder = f.path.split(/[\/\\]/).slice(-2, -1)[0] || "Unfiled";
        const sizeStr = f.size_bytes ? (f.size_bytes / 1024).toFixed(1) + " KB" : "—";
        const meta = {
          folder,
          ext: (f.extension || "").toUpperCase(),
          size: sizeStr,
          updated: f.modified_at ? new Date(f.modified_at * 1000).toLocaleDateString() : "Just now",
          color: "var(--h-files)",
          icon: "ph-file",
          path: f.path,
          filename: f.filename
        };
        return {
          id: f.id,
          workspace_id: f.workspace_id,
          item_type: f.item_type,
          title: f.title,
          created_at: String(f.modified_at),
          user_pinned: false,
          user_size_preference: null,
          metadata: JSON.stringify(meta)
        };
      });
  }, [fileEntries]);

  const create = useCallback(async (title: string, meta?: any) => {
    assertNotFrozen("Create File");
    const ext = meta?.ext || null;
    const folder = meta?.folder || "Unfiled";
    const createdFile = await fsCreateFile(store.workspaceId!, title, ext, folder);
    const itemPayload = {
      id: createdFile.id,
      workspace_id: createdFile.workspace_id,
      item_type: createdFile.item_type,
      title: createdFile.title,
      created_at: String(createdFile.modified_at),
      user_pinned: false,
      user_size_preference: null,
      metadata: JSON.stringify({
        folder,
        ext: (createdFile.extension || "").toUpperCase(),
        size: createdFile.size_bytes ? (createdFile.size_bytes / 1024).toFixed(1) + " KB" : "—",
        updated: "Just now",
        color: "var(--h-files)",
        icon: "ph-file",
        path: createdFile.path,
        filename: createdFile.filename
      })
    };
    await emit("loom://event", { type: 'ITEM_CREATED', payload: itemPayload });
    await store.refresh();
    return items.find(i => i.id === createdFile?.id) || items[0];
  }, [store, items]);

  const remove = useCallback(async (id: string) => {
    assertNotFrozen("Delete File");
    await fsDeleteFile(id);
    await emit("loom://event", { type: 'ITEM_DELETED', payload: { id } });
    await store.refresh();
  }, [store]);

  const updateFields = useCallback(async (id: string, title: string) => {
    assertNotFrozen("Rename File");
    await fsRenameFile(id, title);
    const wsItems = await getItems(store.workspaceId!);
    const renamedFile = wsItems.find(x => x.id === id);
    if (renamedFile) await emit("loom://event", { type: 'ITEM_UPDATED', payload: renamedFile });
    await store.refresh();
    return items.find(i => i.id === id) || items[0];
  }, [store, items]);

  const importFile = useCallback(async (sourcePath: string, strategy: "copy" | "reference") => {
    assertNotFrozen("Import File");
    const importedFile = await fsImportFile(store.workspaceId!, sourcePath, strategy);
    const filename = sourcePath.split(/[\/\\]/).pop() || "file";
    const ext = filename.split(".").pop()?.toUpperCase() || "—";
    const itemPayload = {
      id: importedFile.id,
      workspace_id: importedFile.workspace_id,
      item_type: "file",
      title: filename.replace(/\.[^/.]+$/, ""),
      created_at: String(Date.now()),
      user_pinned: false,
      user_size_preference: null,
      metadata: JSON.stringify({
        folder: "Unfiled",
        ext,
        size: "—",
        updated: "Just now",
        color: "var(--h-files)",
        icon: "ph-file",
        path: importedFile.path,
        filename
      })
    };
    await emit("loom://event", { type: 'ITEM_CREATED', payload: itemPayload });
    await store.refresh();
    return importedFile;
  }, [store]);

  return {
    items,
    create,
    importFile,
    openFile: fsOpenFile,
    revealInExplorer: fsRevealInExplorer,
    links: store.links,
    updateMeta: store.updateMeta,
    updateFields,
    remove,
    restore: store.restore,
    workspaceId: store.workspaceId,
    ready: store.ready,
    error: store.error,
  };
}

export function useNotes() {
  const store = useItemStore();
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);

  useEffect(() => {
    if (store.workspaceId && store.ready) {
      fsGetFiles(store.workspaceId)
        .then(setFileEntries)
        .catch(console.error);
    }
  }, [store.workspaceId, store.ready, store.items]);

  // Convert FileEntry of type "note" to standard items
  const items = useMemo(() => {
    return fileEntries
      .filter(f => f.item_type === "note")
      .map(f => {
        let cachedMeta = {
          folder: "Notes",
          preview: "Empty note.",
          words: 0,
          tag: "",
          body: [],
          path: f.path,
          filename: f.filename
        };
        try {
          const itemInStore = store.items.find(it => it.id === f.id);
          if (itemInStore && itemInStore.metadata) {
            cachedMeta = { ...cachedMeta, ...JSON.parse(itemInStore.metadata) };
          }
        } catch(e) {}
        
        return {
          id: f.id,
          workspace_id: f.workspace_id,
          item_type: "note",
          title: f.title,
          created_at: String(f.modified_at),
          user_pinned: false,
          user_size_preference: null,
          metadata: JSON.stringify(cachedMeta)
        };
      });
  }, [fileEntries, store.items]);

  const create = useCallback(async (title: string, _meta?: any) => {
    assertNotFrozen("Create Note");
    const createdNote = await fsCreateNote(store.workspaceId!, title);
    const itemPayload = {
      id: createdNote.id,
      workspace_id: createdNote.workspace_id,
      item_type: "note",
      title: createdNote.title,
      created_at: String(createdNote.modified_at),
      user_pinned: false,
      user_size_preference: null,
      metadata: JSON.stringify({
        folder: "Notes",
        preview: "Empty note.",
        words: 0,
        tag: "",
        body: [],
        path: createdNote.path,
        filename: createdNote.filename
      })
    };
    await emit("loom://event", { type: 'ITEM_CREATED', payload: itemPayload });
    await store.refresh();
    return items.find(i => i.id === createdNote?.id) || items[0];
  }, [store, items]);

  const remove = useCallback(async (id: string) => {
    assertNotFrozen("Delete Note");
    await fsDeleteFile(id);
    await emit("loom://event", { type: 'ITEM_DELETED', payload: { id } });
    await store.refresh();
  }, [store]);

  const updateFields = useCallback(async (id: string, title: string) => {
    assertNotFrozen("Rename Note");
    await fsRenameFile(id, title);
    const wsItems = await getItems(store.workspaceId!);
    const renamedNote = wsItems.find(x => x.id === id);
    if (renamedNote) await emit("loom://event", { type: 'ITEM_UPDATED', payload: renamedNote });
    await store.refresh();
    return items.find(i => i.id === id) || items[0];
  }, [store, items]);

  const importNote = useCallback(async (sourcePath: string) => {
    assertNotFrozen("Import Note");
    const importedNote = await fsImportNoteFile(store.workspaceId!, sourcePath);
    const filename = sourcePath.split(/[\/\\]/).pop() || "note";
    const itemPayload = {
      id: importedNote.id,
      workspace_id: importedNote.workspace_id,
      item_type: "note",
      title: filename.replace(/\.[^/.]+$/, ""),
      created_at: String(Date.now()),
      user_pinned: false,
      user_size_preference: null,
      metadata: JSON.stringify({
        folder: "Notes",
        preview: "Imported note.",
        words: 0,
        tag: "",
        body: [],
        path: importedNote.path,
        filename
      })
    };
    await emit("loom://event", { type: 'ITEM_CREATED', payload: itemPayload });
    await store.refresh();
    return importedNote;
  }, [store]);

  return {
    items,
    create,
    importNote,
    readNoteContent: fsReadNoteContent,
    writeNoteContent: fsWriteNoteContent,
    openFile: fsOpenFile,
    revealInExplorer: fsRevealInExplorer,
    links: store.links,
    updateMeta: store.updateMeta,
    updateFields,
    remove,
    restore: store.restore,
    workspaceId: store.workspaceId,
    ready: store.ready,
    error: store.error,
  };
}
