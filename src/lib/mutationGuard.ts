// Minimal write-freeze, used only by the destructive "Clear All Data" flow:
// freeze before the backend wipe, then the app reloads. This replaces the old
// MutationEngine, whose JS-level rollback orchestration is now redundant — every
// IPC mutation is atomic in Rust (the savepoint model fixed in E9), so a failed
// write commits nothing and there is nothing for the frontend to roll back.
let frozen = false;

export function freezeMutations() { frozen = true; }
export function unfreezeMutations() { frozen = false; }

export function assertNotFrozen(name: string) {
  if (frozen) {
    console.warn(`Blocked mutation [${name}] because the system is frozen.`);
    throw new Error(`System is frozen. Cannot execute: ${name}`);
  }
}
