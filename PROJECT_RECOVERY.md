# LOOM AI Recovery & Bootstrap Guide

This document contains the critical knowledge base, architectural invariants, active priorities, and rules required for an AI agent to immediately resume development on LOOM.

---

## 1. Core Architecture Assumptions

LOOM operates under a strict **Deterministic Local-First Reality**:
1. **SQLite as the Single Source of Truth:** Every piece of data (workspaces, items, links, file records, layouts, and settings) resides in SQLite (`loom.db`).
2. **React as a Synchronized Render Cache:** The frontend React store (`useItemStore`) is strictly a read-only mirror of the SQLite state. It must *never* hold authority over data.
3. **Database-First Mutations (Two-Phase Commit):** Any UI action must first execute an async IPC command. The backend stages the intent, runs the mutation in a transaction, verifies integrity, commits, and returns. Only after the IPC promise resolves is the React cache updated.
4. **Drift Protection (Split-Brain Verifier):** A background verifier (`SplitBrainVerifier`) compares a hash of React state with SQLite every 3 seconds. Any drift triggers an immediate red-screen halt.

---

## 2. Critical System Invariants

Adhere to these rules to avoid breaking the application state:
* **No Inline Metadata Links:** Relationship edges *must* reside in the `links` table. Never serialize source/target arrays directly into `items.metadata` JSON strings.
* **Orphan-Free Selection:** Selectors in `relations.ts` must filter neighborhood queries against the active `items` cache, ensuring deleted items instantly disappear without leaving dangling references.
* **Immutable Entity IDs:** IDs (UUIDs) are referential anchors. When undoing a delete, use `restore_snapshot` which performs an `UPDATE items SET deleted=0` instead of inserting a new row with a fresh ID.
* **No Mock Data/Counters:** All statistics and counts must be computed/derived directly from live SQLite database projections.

---

## 3. Dangerous Areas & Critical Files

Be extremely cautious when modifying these files:
* [commands.rs](file:///a:/GngItAll/gng-it-all/src-tauri/src/commands.rs): Houses `execute_two_phase` and `verify_integrity_all`. Any bugs here will corrupt the mutation ledger, cause database lockouts, or result in cascade integrity checks blocking valid writes.
* [itemStore.tsx](file:///a:/GngItAll/gng-it-all/src/lib/itemStore.tsx): The central React store. Direct state mutations here without matching database actions will trigger the `SplitBrainVerifier` red screen.
* [splitBrainVerifier.tsx](file:///a:/GngItAll/gng-it-all/src/lib/splitBrainVerifier.tsx): Defines the divergence detection checks. Messing with this or ignoring console errors will make the app unstable.

---

## 4. Current Unfinished Work

* **Undo/Redo referential loss:** Creating a note/task, linking it, deleting it, and then pressing Ctrl+Z currently recreates the note/task with a *new* ID. This breaks all existing link records pointing to the original ID. The fix requires the undo command to invoke `restore_snapshot` via IPC using the archived item object and link records.
* **Vault Cryptography:** The `vault` module is a stub. Plaintext metadata is stored in SQLite. Encryption at rest must be implemented by integrating `crypto_commands::encrypt_path` / `decrypt_path` and encrypting the JSON `metadata` field of vault items.
* **Automations Engine:** Trigger/action definitions exist in database metadata (`on`, `runs`, `chain`), but no execution runner exists. A background loop or event bus is needed in Rust to monitor `mutation_ledger` and dispatch actions.
* **Dashboard Widget Slicing:** Expanded dashboard widgets slice the global item arrays inside their render methods (`items.slice(0, 5)`), causing performance bottlenecks on larger vaults. They should use `useMemo` or backend database limits.

---

## 5. Development Guidelines & Rules

1. **Keep Abstractions Clean:** Use metadata extraction functions in [meta.ts](file:///a:/GngItAll/gng-it-all/src/lib/meta.ts) (e.g. `getTaskMeta`, `getNoteMeta`) to parse the JSON `metadata` column on the frontend instead of running `JSON.parse` manually.
2. **Never fetch directly:** All components must read data from `useItemStore` or typed hooks (`useTasks`, `useNotes`). Never issue direct file reads or network calls inside layout components.
3. **WAL Journaling:** SQLite operates in WAL (Write-Ahead Logging) mode. Checkpoints are automatically run during `optimize_database`.
4. **File-Note Synchrony:** Both notes and files exist as files on disk and records in SQLite. When deleting a workspace or file entity, you must delete the physical file on disk *and* clean up the `items` and `files` tables in a single transaction.

---

## 6. Recommended Order of Future Work

1. **Fix Undo Referential Identity:** Refactor [commands.tsx](file:///a:/GngItAll/gng-it-all/src/lib/commands.tsx) to pass the original `Item` and its associated `Link[]` array into the `deleteCommand` undo handler, and call `restore` to reinstate the exact UUIDs in SQLite.
2. **Memoize Dashboard Layouts:** Refactor [Dashboard.tsx](file:///a:/GngItAll/gng-it-all/src/components/Dashboard.tsx) widgets to use memoized filters, eliminating raw `items.slice()` in render paths.
3. **Implement Modal Focus Locks:** Add focus trap overrides in [Modal.tsx](file:///a:/GngItAll/gng-it-all/src/components/Modal.tsx) to prevent keyboard tab navigation from escaping open dialog screens.
4. **Integrate Vault at-rest AES Encryption:** Implement metadata encryption for `vault` item types.
