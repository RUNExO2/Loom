// ── Custom Theme Engine ─────────────────────────────────────────────────────────
// A real, schema-driven theme customiser. The whole UI is already built on CSS custom
// properties (see index.css design tokens), so "theming" = overriding those tokens.
// When a custom theme is enabled we write its overrides as inline custom properties on
// <html>; disabling removes them, instantly reverting to the active base theme. No
// restart, no stylesheet rebuild.
//
// Persistence lives in the same settings table as every other UI preference. Multiple
// named themes are stored as a list; one is active at a time.

import { getSetting, setSetting, getThemePresets } from "../ipc/items";
import { getCustomCss } from "../ipc/content";

// Live CSS reload: (re)inject the concatenated user CSS from the Custom CSS folder into a
// single managed <style> tag. Called at launch and whenever the window regains focus, so
// edits to the .css files show up without restarting the app.
export async function reloadCustomCss(): Promise<void> {
  const css = await getCustomCss().catch(() => "");
  let el = document.getElementById("loom-custom-css") as HTMLStyleElement | null;
  if (!el) { el = document.createElement("style"); el.id = "loom-custom-css"; document.head.appendChild(el); }
  el.textContent = css || "";
}

export type FieldType = "color" | "scale" | "select" | "text";

export interface ThemeField {
  key: string;            // CSS custom property this control overrides
  label: string;
  type: FieldType;
  default?: string | number; // representative base value (picker seed only)
  min?: number; max?: number; step?: number; unit?: string;
  options?: { value: string; label: string }[];
  hint?: string;
}
export interface ThemeGroup { title: string; icon: string; fields: ThemeField[]; }

// Effects are composed into a single root `filter` rather than set as vars.
export const FX_KEYS = ["--ct-blur", "--ct-brightness", "--ct-contrast", "--ct-saturate", "--ct-opacity"];

export const THEME_SCHEMA: ThemeGroup[] = [
  {
    title: "Typography", icon: "ph-text-aa",
    fields: [
      { key: "--font-ui", label: "Font family", type: "select", default: '"Inter", system-ui, sans-serif', options: [
        { value: '"Inter", -apple-system, "Segoe UI", system-ui, sans-serif', label: "Inter" },
        { value: '-apple-system, "Segoe UI", system-ui, sans-serif', label: "System UI" },
        { value: '"Iowan Old Style", Georgia, "Times New Roman", serif', label: "Serif" },
        { value: '"SF Mono", ui-monospace, "Cascadia Code", monospace', label: "Monospace" },
        { value: 'Georgia, "Times New Roman", serif', label: "Georgia" },
      ] },
      { key: "--ui-scale", label: "Font size", type: "scale", min: 0.8, max: 1.4, step: 0.05, default: 1, hint: "Scales every UI text size." },
      { key: "--ui-weight", label: "Base weight", type: "select", default: "400", options: [
        { value: "300", label: "Light" }, { value: "400", label: "Regular" }, { value: "500", label: "Medium" }, { value: "600", label: "Semibold" },
      ] },
      { key: "--letter-spacing", label: "Letter spacing", type: "scale", min: -0.04, max: 0.12, step: 0.005, default: -0.01, unit: "em", hint: "Tracking for UI prose." },
      { key: "--line-height", label: "Line height", type: "scale", min: 1, max: 2, step: 0.05, default: 1.45 },
    ],
  },
  {
    title: "Window", icon: "ph-app-window",
    fields: [
      { key: "--win-radius", label: "Corner radius", type: "scale", min: 0, max: 28, step: 1, default: 0, unit: "px", hint: "Rounds the app frame." },
      { key: "--win-border-width", label: "Border thickness", type: "scale", min: 0, max: 4, step: 0.5, default: 0, unit: "px" },
      { key: "--win-border-opacity", label: "Border opacity", type: "scale", min: 0, max: 1, step: 0.05, default: 1 },
      { key: "--win-shadow-strength", label: "Shadow strength", type: "scale", min: 0, max: 2, step: 0.05, default: 0, hint: "Inner vignette on the frame." },
    ],
  },
  {
    title: "Surfaces", icon: "ph-stack",
    fields: [
      { key: "--bg-opacity", label: "Background opacity", type: "scale", min: 0, max: 1, step: 0.05, default: 1, hint: "Lets a background image show through the app fill." },
      { key: "--surface-opacity", label: "Surface opacity", type: "scale", min: 0, max: 1, step: 0.05, default: 1, hint: "Sidebar + titlebar chrome." },
      { key: "--card-opacity", label: "Card opacity", type: "scale", min: 0, max: 1, step: 0.05, default: 1, hint: "Dashboard cards." },
    ],
  },
  {
    title: "Motion", icon: "ph-wave-sine",
    fields: [
      { key: "--motion-enabled", label: "Animations", type: "select", default: "1", options: [
        { value: "1", label: "On" }, { value: "0", label: "Off" },
      ] },
      { key: "--motion-scale", label: "Animation speed", type: "scale", min: 0.25, max: 2, step: 0.05, default: 1, hint: "Higher = slower transitions." },
    ],
  },
  {
    title: "Shape & depth", icon: "ph-bounding-box",
    fields: [
      { key: "--radius-scale", label: "Corner roundness", type: "scale", min: 0, max: 2, step: 0.1, default: 1 },
      { key: "--shadow-2", label: "Shadow depth", type: "select", default: "", options: [
        { value: "none", label: "None" },
        { value: "0 2px 8px rgba(0,0,0,0.18)", label: "Subtle" },
        { value: "0 6px 20px rgba(0,0,0,0.28)", label: "Default" },
        { value: "0 14px 40px rgba(0,0,0,0.42)", label: "Strong" },
      ] },
    ],
  },
  {
    title: "Effects", icon: "ph-sparkle",
    fields: [
      { key: "--ct-blur", label: "Blur", type: "scale", min: 0, max: 16, step: 1, default: 0, unit: "px" },
      { key: "--ct-brightness", label: "Brightness", type: "scale", min: 0.6, max: 1.4, step: 0.02, default: 1 },
      { key: "--ct-contrast", label: "Contrast", type: "scale", min: 0.6, max: 1.4, step: 0.02, default: 1 },
      { key: "--ct-saturate", label: "Saturation", type: "scale", min: 0, max: 2, step: 0.05, default: 1 },
      { key: "--ct-opacity", label: "Opacity", type: "scale", min: 0.4, max: 1, step: 0.02, default: 1 },
    ],
  },
  {
    title: "Colors", icon: "ph-palette",
    fields: [
      { key: "--bg", label: "Background", type: "color", default: "#16161c" },
      { key: "--accent", label: "Accent", type: "color", default: "#8b5cf6" },
      { key: "--surface-1", label: "Surface / cards", type: "color", default: "#1d1e26" },
      { key: "--surface-2", label: "Inputs", type: "color", default: "#24252f" },
      { key: "--glass", label: "Sidebar / glass", type: "color", default: "#1a1b22" },
      { key: "--border", label: "Borders", type: "color", default: "#2a2b33" },
      { key: "--text", label: "Text", type: "color", default: "#f5f5f7" },
      { key: "--text-dim", label: "Secondary text", type: "color", default: "#b9b9c2" },
      { key: "--surface-hover", label: "Hover", type: "color", default: "#2a2b35" },
      { key: "--selection-bg", label: "Text selection", type: "color", default: "#8b5cf6" },
      { key: "--graph-edge", label: "Graph edges", type: "color", default: "#5a5a6a" },
      { key: "--graph-label", label: "Graph labels", type: "color", default: "#f5f5f7" },
      { key: "--reader-bg", label: "Reader background", type: "color", default: "#1d1e26" },
      { key: "--reader-text", label: "Reader text", type: "color", default: "#cfcfd6" },
    ],
  },
];

// Every var the engine may set (effects excluded - they compose `filter`).
export const MANAGED_VAR_KEYS = THEME_SCHEMA
  .flatMap((g) => g.fields.map((f) => f.key))
  .filter((k) => !FX_KEYS.includes(k));

export interface CustomTheme {
  id: string;
  name: string;
  blurb: string;
  tokens: Record<string, string>;
}

export type ThemePreset = CustomTheme;

const ENABLED_KEY = "loom.customTheme.enabled";
const LIST_KEY = "loom.customTheme.list";
const ACTIVE_KEY = "loom.customTheme.active";

export interface CustomThemeState { enabled: boolean; themes: CustomTheme[]; activeId: string | null; }

export function newThemeId(): string { return "ct_" + Math.random().toString(36).slice(2, 10); }

export function newTheme(name = "My theme"): CustomTheme {
  return { id: newThemeId(), name, blurb: "", tokens: {} };
}

export function activeTheme(state: CustomThemeState): CustomTheme | null {
  return state.themes.find((t) => t.id === state.activeId) || state.themes[0] || null;
}

// Effects (blur/brightness/…) compose into a single CSS `filter`. Shared by the engine
// and the Theme Studio live preview so both render effects identically.
export function composeFilter(tokens: Record<string, string> | undefined): string {
  const t = tokens || {};
  const num = (k: string, d: number) => { const v = parseFloat(t[k]); return Number.isFinite(v) ? v : d; };
  const blur = num("--ct-blur", 0), br = num("--ct-brightness", 1), co = num("--ct-contrast", 1),
    sa = num("--ct-saturate", 1), op = num("--ct-opacity", 1);
  const parts: string[] = [];
  if (blur > 0) parts.push(`blur(${blur}px)`);
  if (br !== 1) parts.push(`brightness(${br})`);
  if (co !== 1) parts.push(`contrast(${co})`);
  if (sa !== 1) parts.push(`saturate(${sa})`);
  if (op !== 1) parts.push(`opacity(${op})`);
  return parts.join(" ");
}

// The node that carries the composed `filter`. We use #root, not <html>, so visual
// effects wrap the running app while portalled overlays (Theme Studio, command palette)
// stay crisp and usable. Falls back to <html> if the root mount isn't present.
function fxTarget(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (document.getElementById("root") as HTMLElement) || document.documentElement;
}

// Write (or clear) the active theme's effects `filter` on #root. Pure DOM helper — the
// token overrides on <html> and the bg/custom merge are handled by themeStore, which
// calls this. Always clears first so a removed effect reverts immediately.
export function applyThemeFilter(theme: CustomTheme | null, enabled: boolean) {
  if (typeof document === "undefined") return;

  const s = document.documentElement.style;
  const fx = fxTarget();
  s.removeProperty("filter");                 // clear any legacy filter left on <html>
  if (fx) fx.style.removeProperty("filter");
  if (!enabled || !theme) return;

  const filter = composeFilter(theme.tokens || {});
  if (filter && fx) fx.style.setProperty("filter", filter);
}

// ── Persistence ──
export async function getCustomThemeState(): Promise<CustomThemeState> {
  const [en, dbPresets, active] = await Promise.all([
    getSetting(ENABLED_KEY), getThemePresets(), getSetting(ACTIVE_KEY),
  ]);
  const themes: CustomTheme[] = dbPresets.map(p => {
    let tokens: Record<string, string> = {};
    try { tokens = typeof p.tokens === "string" ? JSON.parse(p.tokens) : p.tokens; } catch { /* ignore */ }
    return {
      id: p.id,
      name: p.name,
      blurb: p.blurb,
      tokens: tokens || {},
    };
  });
  const activeId = active && themes.some((t) => t.id === active) ? active : (themes[0]?.id ?? null);
  return { enabled: en === "on", themes, activeId };
}
export async function saveCustomThemes(themes: CustomTheme[]) {
  // Deprecated list setting; we now save themes individually via Tauri commands.
  // We keep this function as a no-op to avoid breaking imports elsewhere.
}
export async function setCustomThemeEnabled(on: boolean) { await setSetting(ENABLED_KEY, on ? "on" : "off"); }
export async function setActiveCustomTheme(id: string) { await setSetting(ACTIVE_KEY, id); }

// ── Export / Import ──
export function serializeTheme(t: CustomTheme): string {
  return JSON.stringify({ loomTheme: 1, name: t.name, tokens: t.tokens }, null, 2);
}
export function parseTheme(json: string): CustomTheme {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error("Not a valid LOOM theme file (invalid JSON)."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Not a valid LOOM theme file.");
  const o = raw as Record<string, unknown>;
  if (o.loomTheme !== 1) throw new Error("Not a valid LOOM theme file (missing version marker).");
  if (typeof o.tokens !== "object" || o.tokens === null || Array.isArray(o.tokens))
    throw new Error("Not a valid LOOM theme file (missing tokens).");
  
  const allowed = new Set([...MANAGED_VAR_KEYS, ...FX_KEYS]);
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.tokens as Record<string, unknown>)) {
    if (!allowed.has(k)) {
      throw new Error(`Invalid token key: '${k}'. Only official theme schema variables are allowed.`);
    }
    if (typeof v !== "string" && typeof v !== "number") {
      throw new Error(`Invalid value type for token '${k}': must be a string or number.`);
    }
    const vStr = String(v).trim();
    if (/[{};]/.test(vStr)) {
      throw new Error(`Invalid characters in token '${k}' value: '${vStr}'. Values cannot contain '{', '}', or ';'.`);
    }
    if (vStr) {
      tokens[k] = vStr;
    }
  }
  const name = typeof o.name === "string"
    ? o.name.replace(/[<>"]/g, "").slice(0, 100).trim() || "Imported theme"
    : "Imported theme";
  return { id: newThemeId(), name, blurb: "Imported theme", tokens };
}

// ── Color math - contrast guard for the Studio ──────────────────────────────────
export function hexToRgb(hex: string): [number, number, number] | null {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function channelLum(c: number): number { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
export function relLuminance(rgb: [number, number, number]): number {
  return 0.2126 * channelLum(rgb[0]) + 0.7152 * channelLum(rgb[1]) + 0.0722 * channelLum(rgb[2]);
}
// WCAG contrast ratio. Returns null when either colour isn't a parseable hex (e.g. an
// oklch base token the user hasn't overridden) so the UI can simply hide the badge.
export function contrastRatio(fg: string, bg: string): number | null {
  const a = hexToRgb(fg), b = hexToRgb(bg);
  if (!a || !b) return null;
  const l1 = relLuminance(a), l2 = relLuminance(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
export interface WcagRating { label: string; pass: boolean; }
export function wcagRating(ratio: number): WcagRating {
  if (ratio >= 7) return { label: "AAA", pass: true };
  if (ratio >= 4.5) return { label: "AA", pass: true };
  if (ratio >= 3) return { label: "AA·lg", pass: true };
  return { label: "Low", pass: false };
}

// ── Swatch derivation - preset cards + theme chips ──
export function themeSwatch(tokens: Record<string, string>) {
  const t = tokens || {};
  return {
    bg: t["--bg"] || "#16161c",
    surface: t["--surface-2"] || t["--surface-1"] || "#24252f",
    accent: t["--accent"] || "#8b5cf6",
    text: t["--text"] || "#f5f5f7",
    border: t["--border"] || "#2a2b33",
  };
}

// ── Curated presets ──
// Mock presets list is removed; presets are loaded directly from the database theme_presets table.
export const THEME_PRESETS: ThemePreset[] = [];

// ── CSS export - all current token overrides as a :root block ──
export function themeToCss(tokens: Record<string, string>): string {
  const all = [...MANAGED_VAR_KEYS, ...FX_KEYS];
  const lines = all.filter((k) => tokens[k] != null && tokens[k] !== "").map((k) => `  ${k}: ${tokens[k]};`);
  return lines.length === 0 ? "/* No overrides */" : `:root {\n${lines.join("\n")}\n}`;
}

// ── "Surprise me" - a harmonious random dark theme, generated in HSL (hex output so the
// colour pickers and preview render it directly). ──
function hslHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
export function randomTheme(name = "Surprise"): CustomTheme {
  const h = Math.floor(Math.random() * 360);
  const ah = h + [0, 0, 30, 180, 200][Math.floor(Math.random() * 5)]; // mono or complementary accent
  return {
    id: newThemeId(), name,
    tokens: {
      "--bg": hslHex(h, 22, 7),
      "--surface-1": hslHex(h, 16, 12),
      "--surface-2": hslHex(h, 14, 16),
      "--glass": hslHex(h, 20, 9),
      "--border": hslHex(h, 14, 26),
      "--surface-hover": hslHex(h, 14, 19),
      "--accent": hslHex(ah, 70, 62),
      "--selection-bg": hslHex(ah, 70, 55),
      "--text": hslHex(h, 12, 96),
      "--text-dim": hslHex(h, 9, 72),
      "--reader-bg": hslHex(h, 16, 12),
      "--reader-text": hslHex(h, 9, 84),
      "--graph-edge": hslHex(h, 10, 40),
      "--graph-label": hslHex(h, 12, 96),
    },
  };
}
