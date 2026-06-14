import { invoke } from "@tauri-apps/api/core";

// Allows continuous live fuzzing of IPC
declare global {
  interface Window {
    __FUZZ_CONFIG__?: {
      dropRate?: number;
      duplicateRate?: number;
      maxDelayMs?: number;
      forceMicrotaskBatching?: boolean;
    };
  }
}

// A global queue to randomize order of execution if maxDelayMs is set
// let pendingFuzzQueue: Array<() => void> = [];

export async function apiInvoke<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  const fuzz = typeof window !== 'undefined' ? window.__FUZZ_CONFIG__ : undefined;

  // Only apply fuzz to mutating endpoints
  if (fuzz && ['create_item', 'delete_item', 'update_item', 'update_item_intent', 'update_item_metadata', 'link', 'unlink', 'restore_snapshot'].includes(cmd)) {
    if (fuzz.maxDelayMs) {
      const delay = Math.random() * fuzz.maxDelayMs;
      await new Promise((r) => setTimeout(r, delay));
    }
    if (fuzz.forceMicrotaskBatching) {
      await new Promise((r) => queueMicrotask(() => setTimeout(r, 0)));
    }
    if (fuzz.dropRate && Math.random() < fuzz.dropRate) {
      throw new Error(`FuzzMonkey: Artificial network drop for [${cmd}]`);
    }
    if (fuzz.duplicateRate && Math.random() < fuzz.duplicateRate) {
      // Fire it twice to ensure backend deduplicates or is idempotent
      invoke<T>(cmd, args).catch(() => {});
    }
  }

  try {
    return await invoke<T>(cmd, args);
  } catch (error) {
    console.error(`Tauri invoke error [${cmd}]:`, error);
    throw error;
  }
}
