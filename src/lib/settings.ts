// ── Settings authority ─────────────────────────────────────────────────────────
// Settings are device-local UI preferences, NOT domain entities. They live in the
// SQLite `settings` table via the get_setting/set_setting IPC — the single settings
// store. SQLite remains the sole authority for items/workspaces/links; Export/Backup
// read SQLite directly and never persist here.

import { getSetting, setSetting } from "../ipc/items";
import { bgImportImage, bgResolvePath } from "../ipc/fs";

export const THEME_KEY = "loom.theme";       // a theme id or "system"
export const ACCENT_KEY = "loom.accent";     // an accent id
export const STARTUP_KEY = "loom.startup";   // a startup-view id

// ── Theme registry (single source of truth for ids + picker UI) ──
// `swatch` colors are presentational preview data for the Settings picker,
// not runtime style tokens — the real tokens live in index.css theme blocks.
export interface ThemeDef {
  id: string;
  label: string;
  icon: string;
  desc: string;
  family: "dark" | "light";
  swatch: { bg: string; fg: string };
}
export const THEMES: ThemeDef[] = [
  { id: "dark",   label: "Dark",   icon: "ph-moon",          desc: "The LOOM hero theme",      family: "dark",  swatch: { bg: "oklch(0.145 0.008 286)", fg: "oklch(0.965 0.004 286)" } },
  { id: "light",  label: "Light",  icon: "ph-sun",           desc: "Bright and clean",         family: "light", swatch: { bg: "oklch(0.965 0.003 286)", fg: "oklch(0.24 0.01 286)" } },
  { id: "void",   label: "Void",   icon: "ph-circle-dashed", desc: "AMOLED true black",        family: "dark",  swatch: { bg: "#000",                   fg: "oklch(0.965 0.004 286)" } },
  { id: "nebula", label: "Nebula", icon: "ph-planet",        desc: "Deep violet cosmos",       family: "dark",  swatch: { bg: "oklch(0.15 0.035 292)",  fg: "oklch(0.965 0.008 300)" } },
  { id: "aurora", label: "Aurora", icon: "ph-wind",          desc: "Borealis teal",            family: "dark",  swatch: { bg: "oklch(0.15 0.022 210)",  fg: "oklch(0.965 0.006 200)" } },
  { id: "ember",  label: "Ember",  icon: "ph-fire",          desc: "Warm charcoal",            family: "dark",  swatch: { bg: "oklch(0.155 0.014 50)",  fg: "oklch(0.965 0.006 70)" } },
];
const THEME_IDS = new Set(THEMES.map((t) => t.id));

export type ThemePref = string;              // a THEMES id or "system"
export type Resolved = string;               // a THEMES id

// ── Accent registry ──
// `preview` is picker swatch data; runtime hue/chroma live in [data-accent] CSS blocks.
export interface AccentDef { id: string; label: string; preview: string; }
export const ACCENTS: AccentDef[] = [
  { id: "violet", label: "Violet", preview: "oklch(0.66 0.2 300)" },
  { id: "indigo", label: "Indigo", preview: "oklch(0.66 0.19 270)" },
  { id: "azure",  label: "Azure",  preview: "oklch(0.66 0.17 240)" },
  { id: "cyan",   label: "Cyan",   preview: "oklch(0.66 0.15 210)" },
  { id: "jade",   label: "Jade",   preview: "oklch(0.66 0.15 160)" },
  { id: "amber",  label: "Amber",  preview: "oklch(0.66 0.15 75)" },
  { id: "coral",  label: "Coral",  preview: "oklch(0.66 0.17 30)" },
  { id: "rose",   label: "Rose",   preview: "oklch(0.66 0.18 350)" },
];
const ACCENT_IDS = new Set(ACCENTS.map((a) => a.id));

// ── Theme ──
export async function getThemePref(): Promise<ThemePref> {
  const v = await getSetting(THEME_KEY);
  return v && (v === "system" || THEME_IDS.has(v)) ? v : "dark";
}
export async function setThemePref(p: ThemePref) {
  if (p === "system" || THEME_IDS.has(p)) await setSetting(THEME_KEY, p);
}
export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}
export function resolveTheme(p: ThemePref): Resolved {
  if (p === "system") return systemPrefersDark() ? "dark" : "light";
  return THEME_IDS.has(p) ? p : "dark";
}
export function themeFamily(r: Resolved): "dark" | "light" {
  return THEMES.find((t) => t.id === r)?.family ?? "dark";
}
export function applyResolvedTheme(r: Resolved) {
  document.documentElement.dataset.theme = r;
}

// ── Accent ──
export async function getAccentPref(): Promise<string> {
  const v = await getSetting(ACCENT_KEY);
  return v && ACCENT_IDS.has(v) ? v : "violet";
}
export async function setAccentPref(a: string) {
  if (ACCENT_IDS.has(a)) await setSetting(ACCENT_KEY, a);
}
export function applyAccent(a: string) {
  document.documentElement.dataset.accent = a;
}

// ── Interface preferences (font / density / ambient / acrylic / navStyle) ──
// Device-local UI prefs persisted in the settings table, applied as data-attributes on
// <html> that CSS reacts to. Real, persisted, no fake state.
export const FONT_KEY = "loom.font";
export const DENSITY_KEY = "loom.density";
export const AMBIENT_KEY = "loom.ambient";
export const ACRYLIC_KEY = "loom.acrylic";
export const NAV_STYLE_KEY = "loom.navStyle";
export const BG_CONFIG_KEY = "loom.background.config";

export type NavStyle = "sidebar" | "top-pill";

import { BackgroundProfile } from "./backgroundEngine";

export interface BackgroundConfig {
  bgImage: string | null;          // stored: relative "backgrounds/…" or null
  bgDynamic: boolean;
  bgUseColors: boolean;
  bgParallax: boolean;
  profile: BackgroundProfile | null;
  _resolvedPath?: string | null;   // runtime-only: absolute path for convertFileSrc, never persisted
}

/** True for old-format absolute paths (Windows drive letter or Unix root). */
const isAbsolutePath = (p: string) => /^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\');

export const FONTS = [
  { id: "inter", label: "Inter (Default)" },
  { id: "system", label: "System UI" },
  { id: "serif", label: "Serif (Reading)" },
  { id: "mono", label: "Monospace (Coding)" },
];
const FONT_IDS = new Set(FONTS.map((f) => f.id));

export async function getFontPref(): Promise<string> {
  const v = await getSetting(FONT_KEY);
  return v && FONT_IDS.has(v) ? v : "inter";
}
export async function setFontPref(id: string) {
  if (FONT_IDS.has(id)) await setSetting(FONT_KEY, id);
}
export function applyFont(id: string) {
  document.documentElement.dataset.font = FONT_IDS.has(id) ? id : "inter";
}

export type DensityMode = "comfortable" | "compact" | "dense";

export async function getDensityPref(): Promise<DensityMode> {
  const v = await getSetting(DENSITY_KEY);
  if (v === "dense") return "dense";
  if (v === "condensed" || v === "compact") return "compact";
  return "comfortable";
}
export async function setDensityPref(mode: DensityMode) {
  await setSetting(DENSITY_KEY, mode);
}
export function applyDensity(mode: DensityMode) {
  if (mode === "comfortable") {
    delete document.documentElement.dataset.density;
  } else {
    document.documentElement.dataset.density = mode;
  }
}

export async function getAmbientPref(): Promise<boolean> {
  return (await getSetting(AMBIENT_KEY)) === "on";
}
export async function setAmbientPref(on: boolean) {
  await setSetting(AMBIENT_KEY, on ? "on" : "off");
}
export function applyAmbient(on: boolean) {
  if (on) document.documentElement.dataset.ambient = "on";
  else delete document.documentElement.dataset.ambient;
}

export async function getAcrylicPref(): Promise<boolean> {
  return (await getSetting(ACRYLIC_KEY)) === "on";
}
export async function setAcrylicPref(on: boolean) {
  await setSetting(ACRYLIC_KEY, on ? "on" : "off");
}
export function applyAcrylic(on: boolean) {
  if (on) document.documentElement.dataset.acrylic = "on";
  else delete document.documentElement.dataset.acrylic;
}

export async function getNavStylePref(): Promise<NavStyle> {
  const v = await getSetting(NAV_STYLE_KEY);
  return v === "top-pill" ? "top-pill" : "sidebar";
}
export async function setNavStylePref(style: NavStyle) {
  await setSetting(NAV_STYLE_KEY, style);
}
export function applyNavStyle(style: NavStyle) {
  document.documentElement.dataset.nav = style;
}

export async function getBackgroundConfig(): Promise<BackgroundConfig> {
  const v = await getSetting(BG_CONFIG_KEY);
  const def: BackgroundConfig = { bgImage: null, bgDynamic: true, bgUseColors: true, bgParallax: true, profile: null };
  if (!v) return def;
  let config: BackgroundConfig;
  try { config = { ...def, ...(JSON.parse(v) as Partial<BackgroundConfig>) }; }
  catch { return def; }

  if (config.bgImage) {
    // Migration: old configs stored absolute paths — copy into managed storage now.
    if (isAbsolutePath(config.bgImage)) {
      try {
        const rel = await bgImportImage(config.bgImage);
        config.bgImage = rel;
        await setSetting(BG_CONFIG_KEY, JSON.stringify(sanitizeBgConfig(config)));
      } catch {
        // Original file gone or unsupported; clear gracefully.
        config.bgImage = null;
        await setSetting(BG_CONFIG_KEY, JSON.stringify(sanitizeBgConfig(config)));
      }
    }
    // Resolve relative path to absolute for synchronous CSS application.
    if (config.bgImage) {
      try {
        config._resolvedPath = await bgResolvePath(config.bgImage);
      } catch {
        // File missing from managed storage (deleted externally); clear.
        config.bgImage = null;
        config._resolvedPath = null;
        await setSetting(BG_CONFIG_KEY, JSON.stringify(sanitizeBgConfig(config)));
      }
    }
  }
  return config;
}

/** Strip runtime-only fields before persisting. */
function sanitizeBgConfig(c: BackgroundConfig): Omit<BackgroundConfig, '_resolvedPath'> {
  const { _resolvedPath: _, ...rest } = c;
  return rest;
}

export async function setBackgroundConfig(c: BackgroundConfig) {
  await setSetting(BG_CONFIG_KEY, JSON.stringify(sanitizeBgConfig(c)));
}
// NOTE: the merged background + custom-theme CSS apply, and the state it reads, now
// live in themeStore.ts. This module is purely persistence + pure DOM helpers.

// ── Startup view ──
export interface StartupOption { id: string; label: string; icon: string; }
export const STARTUP_VIEWS: StartupOption[] = [
  { id: "dashboard", label: "Dashboard", icon: "ph-squares-four" },
  { id: "tasks", label: "Tasks", icon: "ph-check-square" },
  { id: "notes", label: "Notes", icon: "ph-note" },
  { id: "library", label: "Library", icon: "ph-stack" },
  { id: "calendar", label: "Calendar", icon: "ph-calendar-dots" },
  { id: "projects", label: "Projects", icon: "ph-kanban" },
  { id: "habits", label: "Habits", icon: "ph-pulse" },
  { id: "files", label: "Files", icon: "ph-folder" },
  { id: "timeline", label: "Timeline", icon: "ph-clock-counter-clockwise" },
];
const STARTUP_IDS = new Set(STARTUP_VIEWS.map((v) => v.id));

export async function getStartupView(): Promise<string> {
  const v = await getSetting(STARTUP_KEY);
  return v && STARTUP_IDS.has(v) ? v : "dashboard";
}
export async function setStartupView(id: string) {
  if (STARTUP_IDS.has(id)) await setSetting(STARTUP_KEY, id);
}

// ── Keyboard shortcuts (single source of truth) ────────────────────────────────
// Both App.tsx's global handler and the Settings reference render from this list.
// The `test` predicate IS the binding — there is no second hardcoded definition.
export interface Shortcut {
  id: string;
  keys: string[];
  label: string;
  test: (e: KeyboardEvent) => boolean;
}
export const SHORTCUTS: Shortcut[] = [
  {
    id: "palette",
    keys: ["Ctrl/⌘", "K"],
    label: "Open command palette & search",
    test: (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k",
  },
  {
    id: "quickswitch",
    keys: ["Ctrl/⌘", "O"],
    label: "Quick-switch to any item",
    test: (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o",
  },
  {
    id: "close",
    keys: ["Esc"],
    label: "Close command palette or inspector",
    test: (e) => e.key === "Escape",
  },
  {
    id: "undo",
    keys: ["Ctrl/⌘", "Z"],
    label: "Undo last link action",
    test: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z",
  },
  {
    id: "redo",
    keys: ["Ctrl/⌘", "⇧", "Z"],
    label: "Redo link action",
    test: (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "z",
  },
];
