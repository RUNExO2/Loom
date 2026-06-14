// Accessibility audit: renders the real app shell (mocked IPC) and runs axe-core.
// color-contrast is excluded — happy-dom has no real layout/paint, so axe cannot
// compute it here; contrast is enforced at the token level in index.css instead.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import React from "react";
import axe from "axe-core";
import * as itemsIpc from "../src/ipc/items";
import * as workspacesIpc from "../src/ipc/workspaces";
import * as linksIpc from "../src/ipc/links";

vi.mock("../src/ipc/items", () => ({
  getItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  updateItemMetadata: vi.fn(),
  updateItemIntent: vi.fn(),
  deleteItem: vi.fn(),
  restoreSnapshot: vi.fn(),
  verifyIntegrity: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getTimeline: vi.fn(),
  getStats: vi.fn(),
  getMutationLedger: vi.fn(),
  getSystemHealth: vi.fn(),
  repairIntegrity: vi.fn(),
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
vi.mock("../src/data/loomData", () => ({
  D: { notes: [], tasks: [], media: [], agenda: [], bookmarks: [], projects: [], habits: [], files: [], vault: [], automations: [] },
}));

import { App } from "../src/App";
import { ItemStoreProvider } from "../src/lib/itemStore";
import { CommandStackProvider } from "../src/lib/commands";
import { ModalProvider } from "../src/components/Modal";

describe("axe accessibility audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (workspacesIpc.getWorkspaces as any).mockResolvedValue([{ id: "w1", name: "Default" }]);
    (itemsIpc.getItems as any).mockResolvedValue([]);
    (linksIpc.getLinks as any).mockResolvedValue([]);
    (itemsIpc.getSetting as any).mockResolvedValue(null);
    (itemsIpc.setSetting as any).mockResolvedValue(undefined);
    (itemsIpc.getTimeline as any).mockResolvedValue([]);
    (itemsIpc.getStats as any).mockResolvedValue({
      counts: { activeTasks: 0, completedTasks: 0, projects: 0, habits: 0, notes: 0, bookmarks: 0, files: 0, library: 0, calendar: 0, total: 0 },
      cards: [], series: [0, 0, 0, 0, 0, 0, 0], seriesDays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], seriesMax: 0, hasSeries: false,
    });
  });

  it("app shell + dashboard have no serious/critical axe violations", async () => {
    const { container } = render(
      <ItemStoreProvider>
        <CommandStackProvider>
          <ModalProvider>
            <App />
          </ModalProvider>
        </CommandStackProvider>
      </ItemStoreProvider>
    );

    await waitFor(() => expect(container.querySelector(".app")).toBeTruthy(), { timeout: 5000 });
    // Let the dashboard finish its layout fetch + first paint.
    await waitFor(() => expect(container.querySelector(".dash-grid")).toBeTruthy(), { timeout: 5000 });

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });

    const summary = results.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
    }));
    if (summary.length) console.warn("AXE VIOLATIONS:", JSON.stringify(summary, null, 2));

    const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(blocking.map((v) => v.id)).toEqual([]);
  }, 20000);
});
