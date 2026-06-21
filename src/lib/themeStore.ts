// ── ThemeStore: single source of truth for the whole theme system ──────────────
// Before this existed, theme state was fragmented across three owners:
//   • App.tsx React state          → active theme + accent
//   • settings.ts module globals    → currentBgConfig / currentCustomTheme(+Enabled)
//   • ThemeStudio.tsx React state   → a duplicate copy of custom theme + background
// The module globals existed only so the merged CSS apply could see BOTH the
// background config and the custom theme at once. That cache is now this store.
//
// Authority model (mirrors itemStore): SQLite settings table = durable truth;
// this store = the single in-memory cache + the ONLY code that writes theme CSS to
// the DOM. Every theme change flows through here. Components subscribe via
// useThemeStore(); nothing keeps its own duplicate copy.
//
// Import direction is a strict DAG — this module imports settings.ts and theme.ts;
// neither imports back. That's what keeps "merge bg + custom theme" in one place
// without a cycle.

import { useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ThemePref, Resolved, BackgroundConfig,
  getThemePref, setThemePref as persistThemePref, resolveTheme, applyResolvedTheme,
  getAccentPref, setAccentPref as persistAccentPref, applyAccent,
  getBackgroundConfig, setBackgroundConfig,
} from "./settings";
import { CustomTheme, getCustomThemeState, activeTheme, applyThemeFilter, reloadCustomCss } from "./theme";

export interface ThemeStoreState {
  themePref: ThemePref;          // "system" or a THEMES id
  resolved: Resolved;            // concrete theme id after resolving "system"
  accent: string;                // accent id
  customTheme: CustomTheme | null;
  customEnabled: boolean;
  bg: BackgroundConfig;
}

const DEFAULT_BG: BackgroundConfig = { bgImage: null, bgDynamic: true, bgUseColors: true, bgParallax: true, profile: null };

let state: ThemeStoreState = {
  themePref: "dark", resolved: "dark", accent: "violet",
  customTheme: null, customEnabled: false, bg: DEFAULT_BG,
};

const listeners = new Set<() => void>();
const get = () => state;
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
// A new object identity each change so useSyncExternalStore detects it.
function commit(patch: Partial<ThemeStoreState>) { state = { ...state, ...patch }; listeners.forEach((l) => l()); }
// Persistence is best-effort: a failed settings write must never break the live apply.
const persist = (p: Promise<unknown>) => { p.catch(() => {}); };

// ── Cross-window sync ─────────────────────────────────────────────────────────
// One Tauri event, broadcast to every window. The originating window applies +
// persists locally and tags the message with its own label; receivers apply locally
// only (no persist, no re-emit) and skip messages they sent themselves. Tauri's emit
// reaches current AND future windows that have a listener, so no enumeration, no
// polling, no focus hooks. New windows get correct state from settings at init().
const SYNC_EVENT = "loom://theme-sync";
type SyncMsg =
  | { kind: "theme"; themePref: ThemePref }
  | { kind: "accent"; accent: string }
  | { kind: "custom"; theme: CustomTheme | null; enabled: boolean }
  | { kind: "background"; bg: BackgroundConfig }
  | { kind: "css" };

let _label: string | null = null;
function selfLabel(): string {
  if (_label == null) { try { _label = getCurrentWindow().label; } catch { _label = ""; } }
  return _label;
}
function broadcast(msg: SyncMsg) {
  // try/catch + .catch keeps this a no-op outside a Tauri window (e.g. unit tests).
  try { emit(SYNC_EVENT, { ...msg, src: selfLabel() }).catch(() => {}); } catch { /* not in Tauri */ }
}

// ── The one DOM writer ──────────────────────────────────────────────────────────
// Merges background config + custom theme into inline custom properties on <html>.
// Verbatim port of the former settings.applyCombinedThemeAndBackground(), now reading
// store state instead of module globals.
function renderCombined() {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  const bg = state.bg;

  // 1. Clear readability/blur/overlay variables
  const clearVars = [
    "--bg-img", "--bg-overlay", "--bg-blur",
    "--region-blur-nav", "--region-blur-card", "--region-blur-modal",
    "--region-overlay-nav", "--region-overlay-card", "--region-overlay-modal",
  ];
  clearVars.forEach((k) => root.removeProperty(k));

  // 2. Clear all custom theme variable keys
  const themeKeys = [
    "--font-ui", "--ui-scale", "--ui-weight",
    "--radius-scale", "--shadow-2",
    "--bg", "--accent", "--surface-1", "--surface-2", "--glass", "--border",
    "--text", "--text-dim", "--surface-hover", "--selection-bg",
    "--graph-edge", "--graph-label", "--reader-bg", "--reader-text",
  ];
  themeKeys.forEach((k) => root.removeProperty(k));

  // 3. Apply background parallax & dataset.bg
  if (!bg.bgImage) {
    delete document.documentElement.dataset.bg;
    delete document.documentElement.dataset.parallax;
  } else {
    document.documentElement.dataset.bg = "on";
    // Honor prefers-reduced-motion: never drive the JS mousemove parallax for users
    // who asked for reduced motion (the onMove listener no-ops when this flag is unset).
    const reducedMotion = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (bg.bgParallax && !reducedMotion) {
      document.documentElement.dataset.parallax = "on";
    } else {
      delete document.documentElement.dataset.parallax;
    }

    // Use pre-resolved absolute path when available; fall back to bgImage for
    // legacy absolute paths that bg_resolve_path accepted as-is.
    const imgUrl = bg._resolvedPath ?? bg.bgImage;
    if (!imgUrl) { delete document.documentElement.dataset.bg; }
    else {
      const convertedUrl = (imgUrl.startsWith("http://") || imgUrl.startsWith("https://") || imgUrl.startsWith("asset:") || imgUrl.startsWith("data:"))
        ? imgUrl
        : convertFileSrc(imgUrl);
      // Encode " so the path cannot escape the CSS url("…") context.
      const cssUrl = convertedUrl.replace(/\\/g, "/").replace(/"/g, "%22");
      root.setProperty("--bg-img", `url("${cssUrl}")`);

      // Apply readability cssVars if bgDynamic is true and profile exists
      if (bg.profile && bg.bgDynamic) {
        for (const [k, v] of Object.entries(bg.profile.cssVars)) root.setProperty(k, v);
      }
    }
  }

  // 4. Apply Custom Theme if enabled
  const themeTokens = (state.customEnabled && state.customTheme) ? (state.customTheme.tokens || {}) : {};
  for (const k of themeKeys) {
    const v = themeTokens[k];
    if (v != null && v !== "") root.setProperty(k, v);
  }

  // 5. Apply Background Colors if enabled and not overridden by custom theme
  if (bg.bgImage && bg.profile && bg.bgUseColors) {
    const primary = bg.profile.colors.primary;
    const surfaceTint = bg.profile.colors.surfaceTint;
    if (themeTokens["--accent"] == null || themeTokens["--accent"] === "") root.setProperty("--accent", primary);
    if (themeTokens["--selection-bg"] == null || themeTokens["--selection-bg"] === "") root.setProperty("--selection-bg", primary);
    if (themeTokens["--surface-1"] == null || themeTokens["--surface-1"] === "") root.setProperty("--surface-1", surfaceTint);
  }

  // 6. Effects filter (blur/brightness/…) — composed onto #root, not <html>.
  applyThemeFilter(state.customTheme, state.customEnabled);
}

// ── Local apply (state + DOM + subscriber notify; NO persist, NO broadcast) ──────
// These are what a sync event receiver runs — they must not echo back out.
function applyThemePrefLocal(p: ThemePref) {
  const resolved = resolveTheme(p);
  commit({ themePref: p, resolved });
  applyResolvedTheme(resolved);
}
function applyAccentLocal(a: string) {
  commit({ accent: a });
  applyAccent(a);
}
function applyCustomLocal(theme: CustomTheme | null, enabled: boolean) {
  commit({ customTheme: theme, customEnabled: enabled });
  renderCombined();
}
function applyBackgroundLocal(cfg: BackgroundConfig) {
  commit({ bg: cfg });
  renderCombined();
}

// ── Public mutators (the only way theme state changes) ───────────────────────────
// local apply → persist → broadcast to other windows.
function setThemePref(p: ThemePref) {
  applyThemePrefLocal(p);
  persist(persistThemePref(p));
  broadcast({ kind: "theme", themePref: p });
}

function setAccent(a: string) {
  applyAccentLocal(a);
  persist(persistAccentPref(a));
  broadcast({ kind: "accent", accent: a });
}

// The applied custom theme + on/off. ThemeStudio owns the editable *collection* and
// its persistence (theme list); the store owns which one is live on screen.
// ponytail: broadcasts per call — fine at edit cadence; debounce only if a profiler asks.
function setCustomTheme(theme: CustomTheme | null, enabled: boolean) {
  applyCustomLocal(theme, enabled);
  broadcast({ kind: "custom", theme, enabled });
}

function setBackground(cfg: BackgroundConfig) {
  applyBackgroundLocal(cfg);
  persist(setBackgroundConfig(cfg));
  broadcast({ kind: "background", bg: cfg });
}

// Re-read the Custom CSS folder here and tell every other window to do the same.
async function reloadCss() {
  await reloadCustomCss();
  broadcast({ kind: "css" });
}

// ── Init: load everything from settings, apply once, track the OS scheme ─────────
let inited = false;
async function init() {
  if (inited) return;
  inited = true;
  const [themePref, accent, cts, bg] = await Promise.all([
    getThemePref(), getAccentPref(), getCustomThemeState(), getBackgroundConfig(),
  ]);
  const resolved = resolveTheme(themePref);
  state = {
    themePref, resolved, accent,
    customTheme: activeTheme(cts), customEnabled: cts.enabled, bg,
  };
  applyResolvedTheme(resolved);
  applyAccent(accent);
  renderCombined();

  if (typeof window !== "undefined" && window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (state.themePref !== "system") return;
      const r = resolveTheme("system");
      commit({ resolved: r });
      applyResolvedTheme(r);
    });
  }

  // Receive sync messages from other windows. Skip our own; apply locally only so we
  // never persist or re-broadcast (no echo loop). Errors here must not break launch.
  try {
    await listen<SyncMsg & { src?: string }>(SYNC_EVENT, (e) => {
      const m = e.payload;
      if (!m || m.src === selfLabel()) return;
      switch (m.kind) {
        case "theme": applyThemePrefLocal(m.themePref); break;
        case "accent": applyAccentLocal(m.accent); break;
        case "custom": applyCustomLocal(m.theme, m.enabled); break;
        case "background": applyBackgroundLocal(m.bg); break;
        case "css": reloadCustomCss(); break;
      }
    });
  } catch { /* not in a Tauri window */ }

  // Notify any subscriber that mounted before init resolved.
  listeners.forEach((l) => l());
}

export const themeStore = { init, get, subscribe, setThemePref, setAccent, setCustomTheme, setBackground, reloadCss };

/** React binding — re-renders the caller whenever any theme state changes. */
export function useThemeStore(): ThemeStoreState {
  return useSyncExternalStore(subscribe, get, get);
}
