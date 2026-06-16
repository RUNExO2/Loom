import { describe, it, expect, vi } from "vitest";
import { deleteCommand } from "./commands";
import { Item } from "../ipc/items";
import { Link } from "../ipc/links";

// ── Phase 0 regression lock: undo MUST restore the original identity ────────────
// DEBT-001 (historical) claimed undo recreated entities with NEW ids, orphaning
// every link that pointed at the old id. The delete→undo path now restores the
// exact Item (same UUID) and its link rows via restore_snapshot. These tests fail
// loudly if that ever regresses — Quran bookmarks/highlights (Phase 10) depend on it.

function makeItem(id: string): Item {
  return {
    id,
    workspace_id: "ws_1",
    item_type: "task",
    title: "Original task",
    created_at: "2026-01-01T00:00:00.000Z",
    user_pinned: false,
    user_size_preference: null,
    metadata: JSON.stringify({ done: false, priority: "med" }),
  };
}

function makeLinks(id: string): Link[] {
  return [
    { source_id: id, target_id: "note_9", relationship_type: "rel" },
    { source_id: "project_3", target_id: id, relationship_type: "rel" },
  ] as Link[];
}

describe("deleteCommand — undo identity (DEBT-001 lock)", () => {
  it("do() deletes by the original id", async () => {
    const item = makeItem("task_42");
    const remove = vi.fn(async () => {});
    const restore = vi.fn(async () => {});

    const cmd = deleteCommand(remove, restore, item, makeLinks("task_42"), "Delete Task");
    await cmd.do();

    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("task_42");
  });

  it("undo() restores the SAME id, never a new one", async () => {
    const item = makeItem("task_42");
    const links = makeLinks("task_42");
    const remove = vi.fn(async (_id: string) => {});
    const restore = vi.fn(async (_item: Item, _links: Link[]) => {});

    const cmd = deleteCommand(remove, restore, item, links, "Delete Task");
    await cmd.do();
    await cmd.undo();

    expect(restore).toHaveBeenCalledOnce();
    const [restoredItem] = restore.mock.calls[0];
    // The exact UUID survives the round trip — this is the whole bug class.
    expect(restoredItem.id).toBe("task_42");
    expect(restoredItem).toBe(item);
  });

  it("undo() restores every link row that pointed at the item", async () => {
    const item = makeItem("task_42");
    const links = makeLinks("task_42");
    const remove = vi.fn(async (_id: string) => {});
    const restore = vi.fn(async (_item: Item, _links: Link[]) => {});

    const cmd = deleteCommand(remove, restore, item, links, "Delete Task");
    await cmd.do();
    await cmd.undo();

    const [, restoredLinks] = restore.mock.calls[0];
    expect(restoredLinks).toEqual(links);
    expect(restoredLinks).toHaveLength(2);
    // both directions preserved — neighbour links survive undo
    expect(restoredLinks.map((l: Link) => l.target_id)).toContain("note_9");
    expect(restoredLinks.map((l: Link) => l.source_id)).toContain("project_3");
  });

  it("undo() refuses a tampered snapshot rather than restoring corrupt state", async () => {
    const item = makeItem("task_42");
    const links = makeLinks("task_42");
    const remove = vi.fn(async () => {});
    const restore = vi.fn(async () => {});

    const cmd = deleteCommand(remove, restore, item, links, "Delete Task");
    await cmd.do();
    // Mutate the captured snapshot after construction → integrity hash diverges.
    links.push({ source_id: "task_42", target_id: "injected", relationship_type: "rel" } as Link);

    await expect(cmd.undo()).rejects.toThrow(/hash mismatch/i);
    expect(restore).not.toHaveBeenCalled();
  });
});
