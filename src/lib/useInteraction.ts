import { useState, useCallback, useRef, useEffect } from "react";

// ── Interaction state machine ─────────────────────────────────────────────────────
// The async lifecycle every interactive action shares:
//   idle → loading → success | error → idle
// (focused/active are CSS pseudo-states owned by the design system — not JS state —
// so they aren't modelled here.) This hook makes the lifecycle uniform: no action is
// invisible (loading is always shown), no double-fire (re-entrant runs are ignored),
// and state is never set after unmount.

export type InteractionState = "idle" | "loading" | "success" | "error";

export interface InteractionOptions {
  successMs?: number; // dwell on success before returning to idle (default 1200)
  errorMs?: number;   // dwell on error before returning to idle; 0 = sticky (default 2600)
}

export interface Interaction {
  state: InteractionState;
  error: string | null;
  isLoading: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  reset: () => void;
}

export function useInteraction(opts: InteractionOptions = {}): Interaction {
  const { successMs = 1200, errorMs = 2600 } = opts;
  const [state, setState] = useState<InteractionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);

  useEffect(() => () => {
    alive.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const reset = useCallback(() => {
    clearTimer();
    if (alive.current) { setState("idle"); setError(null); }
  }, []);

  const settle = useCallback((next: "success" | "error", ms: number) => {
    if (!alive.current) return;
    setState(next);
    if (ms > 0) {
      timer.current = setTimeout(() => {
        if (alive.current) { setState("idle"); setError(null); }
      }, ms);
    }
  }, []);

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy.current) return undefined; // ignore re-entrant clicks while in flight
    busy.current = true;
    clearTimer();
    if (alive.current) { setState("loading"); setError(null); }
    try {
      const result = await fn();
      settle("success", successMs);
      return result;
    } catch (e: any) {
      console.error("interaction failed:", e);
      if (alive.current) setError(String(e?.message ?? e));
      settle("error", errorMs);
      return undefined;
    } finally {
      busy.current = false;
    }
  }, [settle, successMs, errorMs]);

  return { state, error, isLoading: state === "loading", run, reset };
}
