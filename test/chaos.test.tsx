import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ItemStoreProvider, useItemStore } from '../src/lib/itemStore';
import { CommandStackProvider, useCommands } from '../src/lib/commands';
import React from 'react';
import * as ipc from '../src/ipc/items';
import * as ipcLinks from '../src/ipc/links';

// We mock the original apiInvoke internally using our fake DB
let mockDB: any = {};
let mockLinks: any[] = [];

vi.mock('../src/ipc/workspaces', () => ({
  getWorkspaces: vi.fn(async () => [{ id: 'ws-1', name: 'Test WS' }]),
  createWorkspace: vi.fn(async () => ({ id: 'ws-1', name: 'Test WS' })),
}));

// Instead of intercepting the direct API, we mock the exported IPC wrappers 
// to simulate the delayed and failing chaos responses at the boundary.
vi.mock('../src/ipc/items', () => ({
  createItem: vi.fn(async (workspace_id, item_type, title, metadata) => {
    // Artificial 50ms delay to simulate IPC
    await new Promise(r => setTimeout(r, 50));
    const id = `chaos-${Date.now()}-${Math.random()}`;
    const item = { id, workspace_id, item_type, title, metadata: JSON.stringify(metadata) };
    mockDB[id] = item;
    return item;
  }),
  deleteItem: vi.fn(async (id) => {
    await new Promise(r => setTimeout(r, 50));
    delete mockDB[id];
  }),
  updateItem: vi.fn(async (id, title, metadata) => {
    await new Promise(r => setTimeout(r, 50));
  }),
  restoreSnapshot: vi.fn(async (item, links) => {
    await new Promise(r => setTimeout(r, 50));
    mockDB[item.id] = item;
  }),
  getItems: vi.fn(async () => {
    if (Object.keys(mockDB).length === 0) return [{ id: 'dummy-1', item_type: 'vault', title: 'Dummy' }];
    return Object.values(mockDB);
  }),
  verifyIntegrity: vi.fn(async () => true),
  getDashboardLayout: vi.fn(async () => []),
  saveDashboardLayout: vi.fn(async () => {}),
}));

vi.mock('../src/ipc/links', () => ({
  createLink: vi.fn(async (source_id, target_id, relationship_type) => {
    return { source_id, target_id, relationship_type, created_at: new Date().toISOString() };
  }),
  deleteLink: vi.fn(),
  getLinks: vi.fn(async () => mockLinks),
}));

vi.mock('../src/ipc/fs', () => ({
  fsCreateFile: vi.fn(),
  fsImportFile: vi.fn(),
  fsOpenFile: vi.fn(),
  fsRevealInExplorer: vi.fn(),
  fsDeleteFile: vi.fn(),
  fsGetFiles: vi.fn(async () => []),
  fsRenameFile: vi.fn(),
  fsCreateNote: vi.fn(),
  fsReadNoteContent: vi.fn(async () => "Content"),
  fsWriteNoteContent: vi.fn(),
  fsImportNoteFile: vi.fn(),
  fsReconcile: vi.fn(async () => {}),
  fsCopyFile: vi.fn(),
  fsWriteAnyFile: vi.fn(),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CommandStackProvider>
    <ItemStoreProvider>{children}</ItemStoreProvider>
  </CommandStackProvider>
);

describe('UI Lifecycle Chaos Testing', () => {
  beforeEach(() => {
    mockDB = {};
    mockLinks = [];
    vi.clearAllMocks();
  });

  it('safely handles violent unmounting during pending IPC mutations', async () => {
    const { result, unmount } = renderHook(() => useItemStore(), { wrapper });
    const unmountFn: () => void = unmount;
    const resultRef: any = result;

    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Trigger a slow mutation
    let promiseResolved = false;
    act(() => {
      resultRef.current.create("note", "Chaos Note", {}).then(() => {
        promiseResolved = true;
      }).catch((e: any) => {
        // Handle unmounted state promise rejection if any
      });
    });

    // Violently unmount IMMEDIATELY before IPC resolves
    unmountFn();

    // Wait for the IPC to actually finish
    await new Promise(r => setTimeout(r, 100));

    // The promise should resolve, and React should NOT throw a warning about updating unmounted state
    // because executeMutation should be defensive.
    expect(promiseResolved).toBe(true);
    expect(Object.keys(mockDB).length).toBe(1); // Backend still succeeded
  });

  it('survives rapid undo/redo spam without race condition corruption', async () => {
    const { result } = renderHook(() => {
      return { store: useItemStore(), cmds: useCommands() };
    }, { wrapper });

    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      await result.current.cmds.run({
        label: 'dummy',
        do: async () => { await new Promise(r => setTimeout(r, 10)); },
        undo: async () => { await new Promise(r => setTimeout(r, 10)); }
      });
    });

    // Verify it's in the stack
    expect(result.current.cmds.canUndo).toBe(true);

    // Spam undo and redo asynchronously
    await act(async () => {
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(result.current.cmds.undo());
        promises.push(result.current.cmds.redo());
      }
      await Promise.all(promises);
    });

    expect(result.current.cmds.failedCommands.length).toBe(0);
  });
});
