import React, { createContext, useContext, useCallback, useRef, useState } from "react";
import { Item } from "../ipc/items";
import { Link } from "../ipc/links";

// ── Command stack (command-based undo/redo) ─────────────────────────────────────
// A Command is a reversible domain operation. `do` applies it, `undo` reverses it —
// both go through ItemStore → SQLite, so the stack stores intent, never derived data.
// Undo/redo simply re-invoke do/undo; the UI reconstructs from SQLite either way.
export interface Command {
  label: string;
  do: () => Promise<void>;
  undo: () => Promise<void>;
  status?: 'pending' | 'success' | 'failed';
  errorReason?: string;
}

interface CommandStackApi {
  run: (cmd: Command) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  failedCommands: Command[];
}

const CommandStackCtx = createContext<CommandStackApi | null>(null);
export const useCommands = () => {
  const c = useContext(CommandStackCtx);
  if (!c) throw new Error("useCommands must be used within CommandStackProvider");
  return c;
};

export function CommandStackProvider({ children }: { children: React.ReactNode }) {
  const [past, setPast] = useState<Command[]>([]);
  const [future, setFuture] = useState<Command[]>([]);
  const [failed, setFailed] = useState<Command[]>([]);
  // Serialise operations — each command hits async IPC; overlapping undo/redo would
  // corrupt stack ordering.
  const busy = useRef(false);

  const run = useCallback(async (cmd: Command) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await cmd.do();
      cmd.status = 'success';
      setPast((p) => [...p, cmd]);
      setFuture([]); // a fresh action invalidates the redo branch
    } catch (e: any) {
      console.error("Command failed:", cmd.label, e);
      cmd.status = 'failed';
      cmd.errorReason = String(e);
      setFailed((f) => [...f, cmd as Command]);
    } finally {
      busy.current = false;
    }
  }, []);

  // A command whose inverse can't apply (an endpoint was deleted) is recorded
  // as a failure rather than throwing to the caller.
  const undo = useCallback(async () => {
    if (busy.current || past.length === 0) return;
    busy.current = true;
    const cmd = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    if (!cmd) { busy.current = false; return; }
    try {
      await cmd.undo();
      setFuture((f) => [cmd as Command, ...f]);
    } catch (e: any) {
      console.error("Undo failed:", cmd!.label, e);
      cmd!.status = 'failed';
      cmd!.errorReason = String(e);
      setFailed((f) => [...f, cmd as Command]);
    } finally {
      busy.current = false;
    }
  }, [past]);

  const redo = useCallback(async () => {
    if (busy.current || future.length === 0) return;
    busy.current = true;
    const cmd = future[0];
    setFuture((f) => f.slice(1));
    if (!cmd) { busy.current = false; return; }
    try {
      await cmd.do();
      setPast((p) => [...p, cmd as Command]);
    } catch (e: any) {
      console.error("Redo failed:", cmd!.label, e);
      cmd!.status = 'failed';
      cmd!.errorReason = String(e);
      setFailed((f) => [...f, cmd as Command]);
    } finally {
      busy.current = false;
    }
  }, [future]);

  const value: CommandStackApi = {
    run, undo, redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undoLabel: past.length > 0 ? past[past.length - 1].label : null,
    redoLabel: future.length > 0 ? future[0].label : null,
    failedCommands: failed,
  };
  return <CommandStackCtx.Provider value={value}>{children}</CommandStackCtx.Provider>;
}

function structuralHash(obj: any): string {
  const str = JSON.stringify(obj);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

export function deleteCommand(
  remove: (id: string) => Promise<void>,
  restore: (item: Item, linksToRestore: Link[]) => Promise<void>,
  item: Item,
  links: Link[],
  label: string = "Delete",
): Command {
  const schema_version = 1;
  const hash = structuralHash({ item, links });

  return {
    label,
    status: 'pending',
    do: async () => await remove(item.id),
    undo: async () => {
      if (schema_version !== 1) throw new Error("Snapshot version mismatch: incompatible restore");
      if (structuralHash({ item, links }) !== hash) throw new Error("Snapshot hash mismatch: corrupted snapshot");
      await restore(item, links);
    },
  };
}

// ── Reversible relationship commands ────────────────────────────────────────────
// Built from the ItemStore link/unlink primitives. link↔unlink are exact inverses.
export function linkCommand(
  link: (a: string, b: string) => Promise<void>,
  unlink: (a: string, b: string) => Promise<void>,
  resolve: (id: string) => any,
  a: string, b: string, label = "Link",
): Command {
  return { 
    label, 
    do: async () => await link(a, b), 
    undo: async () => {
      if (!resolve(a) || !resolve(b)) return;
      await unlink(a, b);
    }
  };
}

export function unlinkCommand(
  link: (a: string, b: string) => Promise<void>,
  unlink: (a: string, b: string) => Promise<void>,
  resolve: (id: string) => any,
  a: string, b: string, label = "Unlink",
): Command {
  return { 
    label, 
    do: async () => await unlink(a, b), 
    undo: async () => {
      if (!resolve(a) || !resolve(b)) return;
      await link(a, b);
    }
  };
}
