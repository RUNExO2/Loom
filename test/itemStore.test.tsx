import { describe, it, expect, vi, beforeEach } from "vitest";
import { ItemStoreProvider, useItemStore } from "../src/lib/itemStore";
import { renderHook, act, waitFor } from "@testing-library/react";
import React from "react";
import * as itemsIpc from "../src/ipc/items";
import * as workspacesIpc from "../src/ipc/workspaces";
import * as linksIpc from "../src/ipc/links";

vi.mock("../src/ipc/items", () => ({
  getItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  updateItemMetadata: vi.fn(),
  deleteItem: vi.fn(),
  restoreSnapshot: vi.fn(),
  verifyIntegrity: vi.fn(),
  getDashboardLayout: vi.fn(async () => []),
  saveDashboardLayout: vi.fn(async () => {}),
}));

vi.mock("../src/ipc/workspaces", () => ({
  getWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
}));

vi.mock("../src/ipc/links", () => ({
  getLinks: vi.fn(),
  createLink: vi.fn(),
  deleteLink: vi.fn(),
}));

vi.mock("../src/ipc/fs", () => ({
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

// Mock initial data to prevent seedAll
vi.mock("../src/data/loomData", () => ({
  D: { notes: [], tasks: [], media: [], agenda: [], bookmarks: [], projects: [], habits: [], files: [], vault: [], automations: [] }
}));

describe("ItemStore executeMutation Gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (workspacesIpc.getWorkspaces as any).mockResolvedValue([{ id: "w1", name: "Default" }]);
    (itemsIpc.getItems as any).mockResolvedValue([]);
    (linksIpc.getLinks as any).mockResolvedValue([]);
  });

  it("blocks cache updates if verifyIntegrity fails", async () => {
    const mockItem = { id: "item1", title: "Test", item_type: "note", workspace_id: "w1", metadata: "{}" };
    (itemsIpc.createItem as any).mockResolvedValue(mockItem);
    (itemsIpc.verifyIntegrity as any).mockRejectedValue(new Error("Integrity verification failed"));

    const { result } = renderHook(() => useItemStore(), { wrapper: ItemStoreProvider });

    await waitFor(() => expect(result.current.ready).toBe(true));

    await expect(async () => {
      await result.current.create("note", "Test");
    }).rejects.toThrow("Integrity verification failed");

    expect(result.current.items.length).toBe(0);
  });

  it("updates cache if verifyIntegrity succeeds", async () => {
    const mockItem = { id: "item1", title: "Test", item_type: "note", workspace_id: "w1", metadata: "{}" };
    (itemsIpc.createItem as any).mockResolvedValue(mockItem);
    (itemsIpc.verifyIntegrity as any).mockResolvedValue(true);

    const { result } = renderHook(() => useItemStore(), { wrapper: ItemStoreProvider });

    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.create("note", "Test");
    });

    expect(result.current.items.length).toBe(1);
    expect(result.current.items[0].id).toBe("item1");
  });
});
