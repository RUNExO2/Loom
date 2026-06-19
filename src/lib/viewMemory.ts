import { useState, useEffect, useCallback } from "react";

// ── View Memory ────────────────────────────────────────────────────────────────
// Persists local UI state (scroll positions, filters, sort orders, layout modes)
// per module so that when users navigate away and back, their state is restored.
// This data is intentionally ephemeral (localStorage) as it is local to the device.

export function useViewMemory<T>(key: string, defaultValue: T): [T, (val: T | ((prev: T) => T)) => void] {
  const fullKey = `loom.viewMemory.${key}`;
  
  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const stored = window.localStorage.getItem(fullKey);
      if (stored !== null) return JSON.parse(stored);
    } catch (e) {
      console.warn("Failed to load view memory for", key, e);
    }
    return defaultValue;
  });

  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    setState((prev) => {
      const next = value instanceof Function ? value(prev) : value;
      try {
        window.localStorage.setItem(fullKey, JSON.stringify(next));
      } catch (e) {
        console.warn("Failed to save view memory for", key, e);
      }
      return next;
    });
  }, [fullKey]);

  // Listen for storage events (if changed from another window)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === fullKey && e.newValue) {
        try { setState(JSON.parse(e.newValue)); } catch (e) { /* ignore */ }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [fullKey]);

  return [state, setValue];
}

// Global Activity tracker for "Recent: Opened"
const RECENT_OPENED_KEY = "loom.activity.recentOpened";

export function trackItemOpened(id: string) {
  if (typeof window === "undefined") return;
  try {
    const stored = window.localStorage.getItem(RECENT_OPENED_KEY);
    let recent: string[] = stored ? JSON.parse(stored) : [];
    // Remove if exists
    recent = recent.filter(x => x !== id);
    // Add to front
    recent.unshift(id);
    // Keep last 50
    if (recent.length > 50) recent = recent.slice(0, 50);
    window.localStorage.setItem(RECENT_OPENED_KEY, JSON.stringify(recent));
    window.dispatchEvent(new Event("loom-recent-opened-changed"));
  } catch (e) {}
}

export function getRecentOpened(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(RECENT_OPENED_KEY);
    if (stored) return JSON.parse(stored);
  } catch (e) {}
  return [];
}
