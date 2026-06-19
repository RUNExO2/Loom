// ── Custom Theme Engine ─────────────────────────────────────────────────────────
// A real, schema-driven theme customiser. The whole UI is already built on CSS custom
// properties (see index.css design tokens), so "theming" = overriding those tokens.
// When a custom theme is enabled we write its overrides as inline custom properties on
// <html>; disabling removes them, instantly reverting to the active base theme. No
// restart, no stylesheet rebuild.
//
// Persistence lives in the same settings table as every other UI preference. Multiple
// named themes are stored as a list; one is active at a time.

import { getSetting, setSetting } from "../ipc/items";
import { setCustomThemeCache, applyCombinedThemeAndBackground } from "./settings";

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

export interface CustomTheme { id: string; name: string; tokens: Record<string, string>; }

const ENABLED_KEY = "loom.customTheme.enabled";
const LIST_KEY = "loom.customTheme.list";
const ACTIVE_KEY = "loom.customTheme.active";

export interface CustomThemeState { enabled: boolean; themes: CustomTheme[]; activeId: string | null; }

export function newThemeId(): string { return "ct_" + Math.random().toString(36).slice(2, 10); }

export function newTheme(name = "My theme"): CustomTheme {
  return { id: newThemeId(), name, tokens: {} };
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

// Write (or clear) the active theme's overrides. Tokens go on <html> so overlays inherit
// the palette too; the effects `filter` rides on #root. Always clears first so a removed
// token reverts to the base theme immediately.
export function applyCustomTheme(theme: CustomTheme | null, enabled: boolean) {
  if (typeof document === "undefined") return;

  setCustomThemeCache(theme, enabled);
  applyCombinedThemeAndBackground();

  const s = document.documentElement.style;
  const fx = fxTarget();
  s.removeProperty("filter");                 // clear any legacy filter left on <html>
  if (fx) fx.style.removeProperty("filter");
  if (!enabled || !theme) return;

  const t = theme.tokens || {};
  const filter = composeFilter(t);
  if (filter && fx) fx.style.setProperty("filter", filter);
}

// ── Persistence ──
export async function getCustomThemeState(): Promise<CustomThemeState> {
  const [en, list, active] = await Promise.all([
    getSetting(ENABLED_KEY), getSetting(LIST_KEY), getSetting(ACTIVE_KEY),
  ]);
  let themes: CustomTheme[] = [];
  try { const parsed = list ? JSON.parse(list) : []; if (Array.isArray(parsed)) themes = parsed; } catch { /* corrupt → empty */ }
  themes = themes.filter((t) => t && typeof t.id === "string" && typeof t.tokens === "object");
  const activeId = active && themes.some((t) => t.id === active) ? active : (themes[0]?.id ?? null);
  return { enabled: en === "on", themes, activeId };
}
export async function saveCustomThemes(themes: CustomTheme[]) { await setSetting(LIST_KEY, JSON.stringify(themes)); }
export async function setCustomThemeEnabled(on: boolean) { await setSetting(ENABLED_KEY, on ? "on" : "off"); }
export async function setActiveCustomTheme(id: string) { await setSetting(ACTIVE_KEY, id); }

// ── Export / Import ──
export function serializeTheme(t: CustomTheme): string {
  return JSON.stringify({ loomTheme: 1, name: t.name, tokens: t.tokens }, null, 2);
}
export function parseTheme(json: string): CustomTheme {
  const o = JSON.parse(json);
  if (!o || typeof o !== "object" || typeof o.tokens !== "object" || o.tokens === null) {
    throw new Error("Not a valid LOOM theme file.");
  }
  // Keep only known token keys to avoid injecting arbitrary properties.
  const allowed = new Set([...MANAGED_VAR_KEYS, ...FX_KEYS]);
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.tokens)) {
    if (allowed.has(k) && typeof v === "string") tokens[k] = v;
  }
  return { id: newThemeId(), name: typeof o.name === "string" ? o.name : "Imported theme", tokens };
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

// ── Curated presets - each a complete, opinionated look applied in one click ──
export interface ThemePreset { name: string; blurb: string; tokens: Record<string, string>; }
export const THEME_PRESETS: ThemePreset[] = [
  {
    name: "Obsidian Bloom", blurb: "Ink violet · the house look",
    tokens: {
      "--bg": "#141019", "--surface-1": "#1d1726", "--surface-2": "#251d31", "--glass": "#17111f",
      "--border": "#33293f", "--surface-hover": "#2a2138", "--accent": "#8b5cf6", "--selection-bg": "#8b5cf6",
      "--text": "#f4f1f8", "--text-dim": "#bdb4c9", "--reader-bg": "#1d1726", "--reader-text": "#d6cfe0",
      "--graph-edge": "#46395a", "--graph-label": "#f4f1f8",
    },
  },
  {
    name: "Solar Ember", blurb: "Warm charcoal · molten amber",
    tokens: {
      "--bg": "#17120d", "--surface-1": "#211a13", "--surface-2": "#2a2119", "--glass": "#1a140e",
      "--border": "#3a2c1f", "--surface-hover": "#30251b", "--accent": "#f0883e", "--selection-bg": "#e0742a",
      "--text": "#f7efe6", "--text-dim": "#cbbaa6", "--reader-bg": "#211a13", "--reader-text": "#e2d4c2",
      "--graph-edge": "#5a4631", "--graph-label": "#f7efe6", "--font-ui": "Georgia, \"Times New Roman\", serif",
    },
  },
  {
    name: "Mint Terminal", blurb: "Near-black · phosphor green · mono",
    tokens: {
      "--bg": "#090d0b", "--surface-1": "#111714", "--surface-2": "#16201b", "--glass": "#0c1210",
      "--border": "#1f2e26", "--surface-hover": "#18241d", "--accent": "#46e0a0", "--selection-bg": "#46e0a0",
      "--text": "#e6f5ee", "--text-dim": "#9fc4b3", "--reader-bg": "#111714", "--reader-text": "#cde8db",
      "--graph-edge": "#2c4a3c", "--graph-label": "#e6f5ee",
      "--font-ui": "\"SF Mono\", ui-monospace, \"Cascadia Code\", monospace", "--radius-scale": "0.4",
    },
  },
  {
    name: "Paper", blurb: "Warm light · ink on cream · serif",
    tokens: {
      "--bg": "#f3efe6", "--surface-1": "#ffffff", "--surface-2": "#faf5ec", "--glass": "#fbf8f1",
      "--border": "#e1d8c7", "--surface-hover": "#efe9db", "--accent": "#b5632a", "--selection-bg": "#e7c9a8",
      "--text": "#2c261d", "--text-dim": "#6b6051", "--reader-bg": "#faf5ec", "--reader-text": "#3a3328",
      "--graph-edge": "#cbbfa8", "--graph-label": "#2c261d", "--font-ui": "Georgia, \"Times New Roman\", serif",
      "--shadow-2": "0 6px 20px rgba(0,0,0,0.10)",
    },
  },
  {
    name: "Sakura Noir", blurb: "Dark plum · petal rose",
    tokens: {
      "--bg": "#160f1a", "--surface-1": "#1f1726", "--surface-2": "#281d30", "--glass": "#180f1d",
      "--border": "#352741", "--surface-hover": "#2c2038", "--accent": "#f06a9a", "--selection-bg": "#f06a9a",
      "--text": "#f6ecf2", "--text-dim": "#c5aec0", "--reader-bg": "#1f1726", "--reader-text": "#e3ceda",
      "--graph-edge": "#4a3554", "--graph-label": "#f6ecf2",
    },
  },
  {
    name: "Deep Sea", blurb: "Abyss navy · bioluminescent cyan",
    tokens: {
      "--bg": "#0a1320", "--surface-1": "#121d2e", "--surface-2": "#182638", "--glass": "#0c1623",
      "--border": "#243750", "--surface-hover": "#1c2c42", "--accent": "#3ec5e0", "--selection-bg": "#3ec5e0",
      "--text": "#e8f2f8", "--text-dim": "#a3bdcf", "--reader-bg": "#121d2e", "--reader-text": "#cfe2ee",
      "--graph-edge": "#2e4a63", "--graph-label": "#e8f2f8",
    },
  },
  {
    name: "Midnight Oil", blurb: "Pitch black · platinum chrome",
    tokens: {
      "--bg": "#080809", "--surface-1": "#101014", "--surface-2": "#18181e", "--glass": "#0a0a0e",
      "--border": "#22222c", "--surface-hover": "#1c1c26", "--accent": "#b0b8d0", "--selection-bg": "#7880a0",
      "--text": "#f8f8fa", "--text-dim": "#8888a0", "--reader-bg": "#101014", "--reader-text": "#c0c0d4",
      "--graph-edge": "#2c2c3c", "--graph-label": "#f8f8fa", "--radius-scale": "0.6",
    },
  },
  {
    name: "Copper Patina", blurb: "Teal slate · molten copper",
    tokens: {
      "--bg": "#0c1218", "--surface-1": "#121c26", "--surface-2": "#182432", "--glass": "#0d141e",
      "--border": "#1e2e3c", "--surface-hover": "#1a2a3a", "--accent": "#d4845a", "--selection-bg": "#b86840",
      "--text": "#e6eef5", "--text-dim": "#88aabb", "--reader-bg": "#121c26", "--reader-text": "#c4dae8",
      "--graph-edge": "#28404e", "--graph-label": "#e6eef5",
    },
  },
  {
    name: "Neon Dusk", blurb: "Smoke purple · electric violet",
    tokens: {
      "--bg": "#10101a", "--surface-1": "#17172a", "--surface-2": "#1e1e36", "--glass": "#12101e",
      "--border": "#2a2848", "--surface-hover": "#22203c", "--accent": "#a855f7", "--selection-bg": "#7c3aed",
      "--text": "#f0ecff", "--text-dim": "#a8a0cc", "--reader-bg": "#17172a", "--reader-text": "#d0c8ee",
      "--graph-edge": "#3a3660", "--graph-label": "#f0ecff",
    },
  },
  {
    name: "Ivory", blurb: "Warm ivory · charcoal serif",
    tokens: {
      "--bg": "#f8f4ee", "--surface-1": "#ffffff", "--surface-2": "#f4efe6", "--glass": "#faf8f2",
      "--border": "#ddd6c8", "--surface-hover": "#ece6da", "--accent": "#3d4a5a", "--selection-bg": "#c0d0e0",
      "--text": "#252018", "--text-dim": "#665a4e", "--reader-bg": "#f4efe6", "--reader-text": "#342a22",
      "--graph-edge": "#bdb4a8", "--graph-label": "#252018",
      "--font-ui": "Georgia, \"Times New Roman\", serif", "--shadow-2": "0 6px 20px rgba(0,0,0,0.10)",
    },
  },
];

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
