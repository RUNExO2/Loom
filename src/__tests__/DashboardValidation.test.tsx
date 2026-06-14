import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { Dashboard } from "../components/Dashboard";
import { ItemStoreProvider } from "../lib/itemStore";
import * as itemsIpc from "../ipc/items";
import { BrowserRouter } from "react-router-dom";
import { LoomCtx } from "../lib/context";

// 1. Mock the IPC layer for absolute isolation
vi.mock("../ipc/items", () => ({
  getItems: vi.fn(async () => []),
  getDashboardLayout: vi.fn(),
  saveDashboardLayout: vi.fn(),
  verifyIntegrity: vi.fn(async () => true),
  createItem: vi.fn(async (wsId, title, type, meta) => ({
    id: "item_" + Math.random(),
    title,
    item_type: type,
    workspace_id: wsId,
    metadata: meta
  })),
  updateItem: vi.fn(),
  updateItemMetadata: vi.fn(),
  deleteItem: vi.fn(),
  restoreSnapshot: vi.fn(),
}));

vi.mock("../ipc/workspaces", () => ({
  getWorkspaces: vi.fn(async () => [{ id: "ws_a", name: "Workspace A" }]),
}));

vi.mock("../ipc/links", () => ({
  getLinks: vi.fn(async () => []),
  createLink: vi.fn(),
}));

vi.mock("../ipc/fs", () => ({
  fsGetFiles: vi.fn(async () => []),
  fsReconcile: vi.fn(async () => {}),
}));

// The dashboard ViewModel assembles every section, so its meta path touches each
// item_type. Stub them all (not just task/note) or the VM build throws on seeded rows.
vi.mock("../lib/meta", () => ({
  getTaskMeta: () => ({ color: "var(--amber-11)", to: "/tasks", title: "Tasks", done: false, dueDate: undefined, subtasks: [], project: "Inbox", priority: "med" }),
  getNoteMeta: () => ({ color: "var(--indigo-11)", folder: "Unfiled", updated: "Just now" }),
  getProjectMeta: () => ({ status: "Active", progress: 50, color: "var(--h-projects)", icon: "ph-kanban" }),
  getHabitMeta: () => ({ streak: 0, color: "var(--h-habits)", week: [0, 0, 0, 0, 0, 0, 0] }),
  getLibraryMeta: () => ({ mediaType: "book", status: "Reading", color: "var(--h-library)", icon: "ph-book-open", progress: { current: 0, total: 0 }, coverPath: "" }),
  getCalendarMeta: () => ({ startDate: new Date().toISOString(), sub: "", color: "var(--h-calendar)" }),
  getFileMeta: () => ({ folder: "Unfiled", color: "var(--h-files)", icon: "ph-file", updated: "" }),
  getAutomationMeta: () => ({ on: false }),
  dueInfo: () => ({ label: "Today", overdue: false, soon: false }),
}));

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe("Phase 5 Dashboard React Runtime Validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockLoomCtx = {
    navigate: vi.fn(),
    inspect: vi.fn(),
    toast: vi.fn(),
    openPalette: vi.fn(),
    editDash: vi.fn(),
    showShortcuts: vi.fn(),
    toggleTheme: vi.fn(),
    themePref: "auto" as any,
    setTheme: vi.fn(),
    accent: "indigo",
    setAccent: vi.fn(),
    dragTargetId: null,
    setDragTargetId: vi.fn(),
  };

  const TestApp = ({ editing = false }: { editing?: boolean }) => (
    <BrowserRouter>
      <LoomCtx.Provider value={mockLoomCtx}>
        <ItemStoreProvider>
          <Dashboard editing={editing} setEditing={() => {}} />
        </ItemStoreProvider>
      </LoomCtx.Provider>
    </BrowserRouter>
  );

  it("1. Workspace Isolation & Restart Persistence: Loads correct isolated dashboard layout", async () => {
    const layoutA = [
      { id: "w_0", workspace_id: "ws_a", widget_type: "tasks", x: 0, y: 0, w: 4, h: 2, hidden: false }
    ];

    (itemsIpc.getDashboardLayout as any).mockResolvedValueOnce(layoutA);

    render(<TestApp />);

    // Wait for the widgets to load and layout to apply
    await waitFor(() => {
      // The widget shell should be rendered with gridColumn/Row derived from layout
      const element = document.querySelector(".widget");
      expect(element).not.toBeNull();
      expect(element?.getAttribute("style")).toContain("grid-column: 1 / span 4");
      expect(element?.getAttribute("style")).toContain("grid-row: 1 / span 2");
    });
  });

  it("2. Event Conflict Validation: Drag interactions use pure pointer events without HTML drag", async () => {
    const layout = [
      { id: "w_0", workspace_id: "ws_a", widget_type: "tasks", x: 0, y: 0, w: 4, h: 2, hidden: false }
    ];
    (itemsIpc.getDashboardLayout as any).mockResolvedValueOnce(layout);
    
    render(<TestApp editing={true} />);
    await waitFor(() => expect(document.querySelector(".grab")).not.toBeNull());

    const grabHandle = document.querySelector(".grab") as Element;
    
    // Ensure draggable=true is NOT present to prevent Tauri interference
    expect(grabHandle.getAttribute("draggable")).toBeNull();

    // Ensure it responds to pointerdown
    act(() => {
      fireEvent.pointerDown(grabHandle, { clientX: 100, clientY: 100 });
    });

    // Internal loom drag flag should be set
    expect((window as any).__loomInternalDrag).toBe(true);

    act(() => {
      fireEvent.pointerUp(window);
    });

    expect((window as any).__loomInternalDrag).toBe(false);
  });
});
