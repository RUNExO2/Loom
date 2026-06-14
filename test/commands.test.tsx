import { describe, it, expect, vi } from "vitest";
import { CommandStackProvider, useCommands, Command, deleteCommand } from "../src/lib/commands";
import { Item } from "../src/ipc/items";
import { renderHook, act } from "@testing-library/react";

describe("CommandStack", () => {
  it("pushes failed commands to failedCommands and sets status", async () => {
    const { result } = renderHook(() => useCommands(), { wrapper: CommandStackProvider });

    const failingCmd: Command = {
      label: "Failing Action",
      do: async () => { throw new Error("Expected failure"); },
      undo: async () => {},
    };

    await act(async () => {
      await result.current.run(failingCmd);
    });

    expect(failingCmd.status).toBe("failed");
    expect(result.current.failedCommands.length).toBe(1);
    expect(result.current.canUndo).toBe(false);
  });

  it("handles snapshot versioning mismatch correctly", async () => {
    const mockRemove = vi.fn();
    const mockRestore = vi.fn();
    const dummyItem: Item = { id: "1", workspace_id: "w1", item_type: "note", title: "T", created_at: "now", user_pinned: false, user_size_preference: null, metadata: "{}" };
    
    const cmd = deleteCommand(mockRemove, mockRestore, dummyItem, []);

    const { result } = renderHook(() => useCommands(), { wrapper: CommandStackProvider });

    await act(async () => {
      await result.current.run(cmd);
    });

    expect(mockRemove).toHaveBeenCalledWith("1");
    expect(result.current.canUndo).toBe(true);

    // Tamper with the snapshot hash
    dummyItem.title = "Tampered";

    await act(async () => {
      await result.current.undo();
    });
    
    expect(mockRestore).not.toHaveBeenCalled();
    expect(result.current.failedCommands.length).toBe(1);
    expect(result.current.failedCommands[0].errorReason).toContain("Snapshot hash mismatch");
  });
});
