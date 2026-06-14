import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { vaultSession } from "../src/lib/vaultSession";
import { mutationEngine, MutationStep } from "../src/lib/mutationEngine";
import * as eventApi from "@tauri-apps/api/event";

describe("VaultSession Lifecycle Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vaultSession.lock();
  });

  it("VaultSession holds password in memory and auto-locks after 5 minutes", () => {
    vi.useFakeTimers();
    const emitSpy = vi.spyOn(eventApi, "emit");

    // Initially locked
    expect(vaultSession.isUnlocked()).toBe(false);

    // Unlock
    vaultSession.unlock("master123");
    expect(vaultSession.isUnlocked()).toBe(true);
    expect(vaultSession.access()).toBe("master123");
    expect(emitSpy).toHaveBeenCalledWith("loom://event", { type: "VAULT_UNLOCKED" });

    // Advance time by 4 minutes - should still be unlocked
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(vaultSession.isUnlocked()).toBe(true);

    // Advance by another 1 minute and 5 seconds - should auto-lock
    vi.advanceTimersByTime(1 * 60 * 1000 + 5000);
    expect(vaultSession.isUnlocked()).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith("loom://event", { type: "VAULT_LOCKED" });

    vi.useRealTimers();
  });

  it("access() resets the inactivity timer", () => {
    vi.useFakeTimers();
    
    // Unlock
    vaultSession.unlock("master123");
    expect(vaultSession.isUnlocked()).toBe(true);

    // Advance by 4 minutes
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(vaultSession.isUnlocked()).toBe(true);

    // Access password (resets the timer)
    expect(vaultSession.access()).toBe("master123");

    // Advance by another 4 minutes (total 8 mins, but only 4 mins since access)
    // Should still be unlocked
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(vaultSession.isUnlocked()).toBe(true);

    // Advance by 2 more minutes - should lock
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(vaultSession.isUnlocked()).toBe(false);

    vi.useRealTimers();
  });
});

describe("MutationEngine Transactional Execution & Rollback", () => {
  it("MutationEngine rolls back executed steps in reverse order on failure", async () => {
    const executed: string[] = [];
    const rolledBack: string[] = [];

    const step1: MutationStep = {
      name: "Step 1",
      execute: async () => {
        executed.push("1");
        return "res1";
      },
      rollback: async () => {
        rolledBack.push("1");
      }
    };

    const step2: MutationStep = {
      name: "Step 2",
      execute: async () => {
        executed.push("2");
        throw new Error("Step 2 failed");
      },
      rollback: async () => {
        rolledBack.push("2");
      }
    };

    const step3: MutationStep = {
      name: "Step 3",
      execute: async () => {
        executed.push("3");
        return "res3";
      },
      rollback: async () => {
        rolledBack.push("3");
      }
    };

    await expect(async () => {
      await mutationEngine.executeMutation("Test Mutation", [step1, step2, step3]);
    }).rejects.toThrow("Step 2 failed");

    // Step 1 and Step 2 should have been executed. Step 3 should not have run.
    expect(executed).toEqual(["1", "2"]);
    
    // Rollback should run only for successfully executed steps (Step 1).
    expect(rolledBack).toEqual(["1"]);
  });
});
