import React, { createContext, useContext, useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
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
      const loaded = await getItems(wsId);
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
      // Only vault lock/unlock comes via loom://event now — all item/link mutations
      // update React state directly (no event-bus roundtrip). The automation engine
      // uses loom://automation-changed (separate listener) to trigger a full refresh.
      const { type } = event.payload;
      if (type === 'VAULT_UNLOCKED') setIsVaultUnlocked(true);
      else if (type === 'VAULT_LOCKED') setIsVaultUnlocked(false);
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

  // Each mutation = an atomic Rust IPC write + a direct React state update.
  // No event-bus roundtrip: emit("loom://event") → listener → setState was a
  // pointless async cycle for same-window mutations. State is updated inline.
  // The loom://event listener is kept only for VAULT_UNLOCKED/LOCKED from vaultSession.
  const create = useCallback(async (type: string, title: string, meta?: any) => {
    if (!workspaceId) throw new Error("No workspace");
    assertNotFrozen(`Create ${type}`);
    const metaString = meta !== undefined ? JSON.stringify(meta) : "{}";
    const createdItem = await ipcCreate(workspaceId, title, type, metaString);
    setItems((prev) => prev.some((x) => x.id === createdItem.id) ? prev : [createdItem, ...prev]);
    return createdItem;
  }, [workspaceId]);

  const updateMeta = useCallback(async (id: string, meta: any) => {
    assertNotFrozen("Update Item Metadata");
    const metaStr = typeof meta === "string" ? meta : JSON.stringify(meta);
    const updatedItem = await ipcUpdateMeta(id, metaStr);
    setItems((prev) => prev.map((x) => (x.id === id ? updatedItem : x)));
    return updatedItem;
  }, []);

  const updateFields = useCallback(async (id: string, title: string, type: string) => {
    assertNotFrozen("Update Item Fields");
    const updatedItem = await ipcUpdate(id, title, type);
    setItems((prev) => prev.map((x) => (x.id === id ? updatedItem : x)));
    return updatedItem;
  }, []);

  const remove = useCallback(async (id: string) => {
    const itemInStore = items.find(x => x.id === id);
    if (!itemInStore) return;
    assertNotFrozen("Delete Item");
    await ipcDelete(id);
    setItems((prev) => prev.filter((x) => x.id !== id));
    setLinks((prev) => prev.filter((l) => l.source_id !== id && l.target_id !== id));
  }, [items]);

  const restore = useCallback(async (item: Item, linksToRestore: Link[]) => {
    assertNotFrozen("Restore Snapshot");
    await ipcRestoreSnapshot(item, linksToRestore);
    setItems((prev) => prev.some((x) => x.id === item.id) ? prev : [item, ...prev]);
    if (linksToRestore.length > 0) {
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
  }, []);

  const link = useCallback(async (a: string, b: string) => {
    if (a === b) return;
    assertNotFrozen("Create Link");
    const createdLinkRow = await createLink(a, b, REL);
    setLinks((prev) => prev.some((l) => l.source_id === createdLinkRow.source_id && l.target_id === createdLinkRow.target_id && l.relationship_type === createdLinkRow.relationship_type) ? prev : [...prev, createdLinkRow]);
  }, []);

  const unlink = useCallback(async (a: string, b: string) => {
    assertNotFrozen("Delete Link");
    await deleteLink(a, b, REL);
    setLinks((prev) => prev.filter((l) =>
      !(l.relationship_type === REL &&
        ((l.source_id === a && l.target_id === b) || (l.source_id === b && l.target_id === a)))
    ));
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
    setDashboardWidgets(widgets);
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
          updated_at: String(f.modified_at),
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
    await store.refresh();
    return items.find(i => i.id === createdFile?.id) || items[0];
  }, [store, items]);

  const remove = useCallback(async (id: string) => {
    assertNotFrozen("Delete File");
    await fsDeleteFile(id);
    await store.refresh();
  }, [store]);

  const updateFields = useCallback(async (id: string, title: string) => {
    assertNotFrozen("Rename File");
    await fsRenameFile(id, title);
    await store.refresh();
    return items.find(i => i.id === id) || items[0];
  }, [store, items]);

  const importFile = useCallback(async (sourcePath: string, strategy: "copy" | "reference") => {
    assertNotFrozen("Import File");
    const importedFile = await fsImportFile(store.workspaceId!, sourcePath, strategy);
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
          updated_at: String(f.modified_at),
          user_pinned: false,
          user_size_preference: null,
          metadata: JSON.stringify(cachedMeta)
        };
      });
  }, [fileEntries, store.items]);

  const create = useCallback(async (title: string, _meta?: any) => {
    assertNotFrozen("Create Note");
    const createdNote = await fsCreateNote(store.workspaceId!, title);
    await store.refresh();
    return items.find(i => i.id === createdNote?.id) || items[0];
  }, [store, items]);

  const remove = useCallback(async (id: string) => {
    assertNotFrozen("Delete Note");
    await fsDeleteFile(id);
    await store.refresh();
  }, [store]);

  const updateFields = useCallback(async (id: string, title: string) => {
    assertNotFrozen("Rename Note");
    await fsRenameFile(id, title);
    await store.refresh();
    return items.find(i => i.id === id) || items[0];
  }, [store, items]);

  const importNote = useCallback(async (sourcePath: string) => {
    assertNotFrozen("Import Note");
    const importedNote = await fsImportNoteFile(store.workspaceId!, sourcePath);
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
