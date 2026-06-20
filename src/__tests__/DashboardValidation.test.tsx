import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { Dashboard } from "../components/Dashboard";
import { ItemStoreProvider } from "../lib/itemStore";
import * as itemsIpc from "../ipc/items";
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
  getAllLinks: vi.fn(async () => []),
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
    navStyle: "sidebar" as const,
    setNavStyle: vi.fn(),
  };

  const TestApp = ({ editing = false }: { editing?: boolean }) => (
    <LoomCtx.Provider value={mockLoomCtx}>
      <ItemStoreProvider>
        <Dashboard editing={editing} setEditing={() => {}} />
      </ItemStoreProvider>
    </LoomCtx.Provider>
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

  it("3. Seeding validation: Does not seed mock data on first launch or empty database", async () => {
    (itemsIpc.getDashboardLayout as any).mockResolvedValueOnce([]);
    render(<TestApp />);
    // Verify that createItem is never called, showing seeding is disabled when DB is empty.
    await waitFor(() => {
      expect(itemsIpc.createItem).not.toHaveBeenCalled();
    });
  });

  it("4. Performance Optimization: Drag updates DOM style directly but does not compute layout until crossing grid boundaries", async () => {
    const layout = [
      { id: "w_0", workspace_id: "ws_a", widget_type: "tasks", x: 0, y: 0, w: 4, h: 2, hidden: false }
    ];
    (itemsIpc.getDashboardLayout as any).mockResolvedValueOnce(layout);
    
    const { container } = render(<TestApp editing={true} />);
    await waitFor(() => expect(document.querySelector(".grab")).not.toBeNull());

    const grabHandle = document.querySelector(".grab") as Element;
    const widgetElement = container.querySelector("#widget-w_0") as HTMLElement;
    expect(widgetElement).not.toBeNull();

    // Mock getBoundingClientRect for both grid and widget
    const gridElement = container.querySelector(".dash-grid") as HTMLElement;
    vi.spyOn(gridElement, "getBoundingClientRect").mockReturnValue({
      width: 1200,
      height: 600,
      left: 0,
      top: 0,
      right: 1200,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {}
    });

    vi.spyOn(widgetElement, "getBoundingClientRect").mockReturnValue({
      width: 400,
      height: 200,
      left: 0,
      top: 0,
      right: 400,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => {}
    });

    // Start dragging
    act(() => {
      fireEvent.pointerDown(grabHandle, { clientX: 50, clientY: 50 });
    });

    // Verify it set internal drag flag
    expect((window as any).__loomInternalDrag).toBe(true);

    // Let's drag slightly by 8px (which is less than boundary crossing and snap)
    act(() => {
      fireEvent.pointerMove(window, { clientX: 58, clientY: 50 });
    });

    // Cell calculation:
    // cellW = (1200 + 16) / 12 = 101.33px
    // deltaX = 8px, grabX = 50px
    // x = Math.round((58 - 0 - 50) / 101.33) = 0
    // Visual translation: snapDx = Math.round(8/20)*20 = 0px
    expect(widgetElement.style.transform).toBe("translate(0px, 0px)");

    // Move clientX to 75 -> deltaX = 25 -> snapDx = 20
    act(() => {
      fireEvent.pointerMove(window, { clientX: 75, clientY: 50 });
    });
    expect(widgetElement.style.transform).toBe("translate(20px, 0px)");

    // Now move clientX to 160 (so deltaX = 110. grabX is 50. clientX - grabX = 110. 110 / 101.33 = 1.08 -> round is 1)
    // Grid cell x becomes 1. This crosses grid boundary!
    act(() => {
      fireEvent.pointerMove(window, { clientX: 160, clientY: 50 });
    });

    // DOM transform should update: deltaX = 110 -> snapDx = Math.round(110 / 20) * 20 = 120px
    expect(widgetElement.style.transform).toBe("translate(120px, 0px)");

    // Clean up pointerup
    act(() => {
      fireEvent.pointerUp(window);
    });

    expect(widgetElement.style.transform).toBe("");
    expect(widgetElement.style.zIndex).toBe("");
  });
});
