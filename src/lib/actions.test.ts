import { describe, it, expect, vi } from "vitest";
import { Item } from "../ipc/items";
import { buildActions, makeActionsApi, ActionDeps } from "./actions";

function deps(): ActionDeps & { _created: any[] } {
  const _created: any[] = [];
  return {
    _created,
    create: vi.fn(async (type: string, title: string, meta?: any) => {
      const it = { id: `id_${_created.length}`, item_type: type, title } as unknown as Item;
      _created.push({ type, title, meta });
      return it;
    }),
    navigate: vi.fn(),
    inspect: vi.fn(),
    toast: vi.fn(),
    editDash: vi.fn(),
    showShortcuts: vi.fn(),
    toggleTheme: vi.fn(),
  };
}

describe("buildActions", () => {
  it("registers a stable set with unique ids", () => {
    const actions = buildActions(deps());
    const ids = actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("cmd-new-note");
    expect(ids).toContain("cmd-theme");
    expect(actions.every((a) => a.title && a.icon && a.section)).toBe(true);
  });

  it("a create action writes a real row then opens it", async () => {
    const d = deps();
    const newTask = buildActions(d).find((a) => a.id === "cmd-new-task")!;
    await newTask.run();
    expect(d._created[0].type).toBe("task");
    expect(d.create).toHaveBeenCalledOnce();
    // create → navigate(view) → inspect(newId) → toast
    expect(d.navigate).toHaveBeenCalledWith("tasks");
    expect(d.inspect).toHaveBeenCalledWith("id_0");
    expect(d.toast).toHaveBeenCalledWith("Task created", "ph-check-circle");
  });

  it("general actions invoke the right dep without touching the store", async () => {
    const d = deps();
    const actions = buildActions(d);
    await actions.find((a) => a.id === "cmd-theme")!.run();
    expect(d.toggleTheme).toHaveBeenCalledOnce();
    await actions.find((a) => a.id === "cmd-edit-dash")!.run();
    expect(d.navigate).toHaveBeenCalledWith("dashboard");
    expect(d.editDash).toHaveBeenCalledOnce();
    expect(d.create).not.toHaveBeenCalled();
  });
});

describe("makeActionsApi", () => {
  it("dispatches by id and no-ops on unknown ids", async () => {
    const d = deps();
    const api = makeActionsApi(d);
    expect(api.actions.length).toBeGreaterThan(0);
    expect(api.byId.get("cmd-shortcuts")).toBeDefined();

    await api.dispatch("cmd-shortcuts");
    expect(d.showShortcuts).toHaveBeenCalledOnce();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    api.dispatch("does-not-exist");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
