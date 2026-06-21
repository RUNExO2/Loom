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
  getBackgroundConfig, setBackgroundConfig, DEFAULT_BG_CONFIG, themeFamily,
} from "./settings";
import { CustomTheme, getCustomThemeState, activeTheme, applyThemeFilter, reloadCustomCss, MANAGED_VAR_KEYS } from "./theme";
import { derivePalette } from "./palette";

export interface ThemeStoreState {
  themePref: ThemePref;          // "system" or a THEMES id
  resolved: Resolved;            // concrete theme id after resolving "system"
  accent: string;                // accent id
  customTheme: CustomTheme | null;
  customEnabled: boolean;
  bg: BackgroundConfig;
}

const DEFAULT_BG: BackgroundConfig = { ...DEFAULT_BG_CONFIG };

// Map a fit mode to the (background-size, background-position) pair CSS needs.
const FIT_CSS: Record<string, { size: string; pos: string }> = {
  cover:   { size: "cover",      pos: "center" },
  contain: { size: "contain",   pos: "center" },
  fill:    { size: "100% 100%", pos: "center" },
  center:  { size: "auto",      pos: "center" },
};

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
    "--bgi-size", "--bgi-pos", "--bgi-blur", "--bgi-bright", "--bgi-contrast", "--bgi-sat", "--bgi-opacity",
    "--accent-l", "--accent-c", "--accent-h", "--text-on-accent",
    "--region-blur-nav", "--region-blur-card", "--region-blur-modal",
    "--region-overlay-nav", "--region-overlay-card", "--region-overlay-modal",
  ];
  clearVars.forEach((k) => root.removeProperty(k));

  // 2. Clear all custom theme variable keys. Derived from the schema (MANAGED_VAR_KEYS)
  // so a new Theme Studio control auto-applies and auto-clears here — no parallel list to
  // keep in sync. Effects (FX_KEYS) are excluded; they compose a filter elsewhere.
  const themeKeys = MANAGED_VAR_KEYS;
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

      // Manual image controls — independent of analysis, applied as a filter on
      // #loom-bg-engine. Defaults keep the image untouched (1 = identity, 0 blur).
      const fit = FIT_CSS[bg.fit] ?? FIT_CSS.cover;
      root.setProperty("--bgi-size", fit.size);
      root.setProperty("--bgi-pos", fit.pos);
      root.setProperty("--bgi-blur", `${bg.blur ?? 0}px`);
      root.setProperty("--bgi-bright", `${bg.brightness ?? 1}`);
      root.setProperty("--bgi-contrast", `${bg.contrast ?? 1}`);
      root.setProperty("--bgi-sat", `${bg.saturation ?? 1}`);
      root.setProperty("--bgi-opacity", `${bg.opacity ?? 1}`);

      // Readability cssVars (scrim + acrylic) are a separate, optional layer.
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

  // 5. Apply the generated palette — accessible (WCAG-checked) and theme-family-aware,
  // so dark/light surface variants adapt when the theme changes. Custom-theme tokens win.
  if (bg.bgImage && bg.profile && bg.bgUseColors) {
    const pal = derivePalette(bg.profile.colors.primary, bg.profile.colors.dominant, themeFamily(state.resolved));
    const free = (k: string) => themeTokens[k] == null || themeTokens[k] === "";
    if (free("--accent")) {
      // Drive the OKLCH component system so --accent-soft/-line/-text/-hover stay in sync.
      root.setProperty("--accent-l", String(pal.accent.l));
      root.setProperty("--accent-c", String(pal.accent.c));
      root.setProperty("--accent-h", String(pal.accent.h));
      root.setProperty("--text-on-accent", pal.onAccent);
    }
    if (free("--selection-bg")) root.setProperty("--selection-bg", pal.accentHex);
    if (free("--surface-1")) root.setProperty("--surface-1", pal.surface1);
    if (free("--surface-2")) root.setProperty("--surface-2", pal.surface2);
    if (free("--graph-edge")) root.setProperty("--graph-edge", pal.graphEdge);
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

// Apply is instant (CSS vars), persist + cross-window broadcast are debounced so a
// slider drag doesn't hammer SQLite or spam other windows — only the settled value
// is written. ponytail: 150ms trailing debounce, plenty for a drag; raise if writes still pile up.
let bgPersistTimer: ReturnType<typeof setTimeout> | null = null;
function setBackground(cfg: BackgroundConfig) {
  applyBackgroundLocal(cfg);
  if (bgPersistTimer) clearTimeout(bgPersistTimer);
  bgPersistTimer = setTimeout(() => {
    bgPersistTimer = null;
    persist(setBackgroundConfig(cfg));
    broadcast({ kind: "background", bg: cfg });
  }, 150);
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
