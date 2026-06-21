// ── Theme Studio state — the single brain behind the (now thin) ThemeStudio shell ──
// Owns: the editable theme collection, active selection, enable toggle, debounced
// persistence (+ flush on unmount), import/export, presets, and palette history.
// The shell and every sub-panel consume this via one `useThemeStudio()` call; nothing
// keeps its own duplicate copy. Background config still lives in themeStore (the app's
// single source of truth) — BackgroundPanel reads it directly.

import { useEffect, useState, useCallback, useRef } from "react";
import { useLoom } from "../../lib/context";
import { useModal } from "../Modal";
import {
  THEME_SCHEMA, CustomTheme,
  getCustomThemeState, saveCustomThemes, setCustomThemeEnabled, setActiveCustomTheme,
  newTheme, serializeTheme, parseTheme,
  ThemePreset, randomTheme, themeToCss,
} from "../../lib/theme";
import { getSetting, setSetting } from "../../ipc/items";
import { save, open } from "@tauri-apps/plugin-dialog";
import { fsWriteAnyFile, fsReadNoteContent } from "../../ipc/fs";
import { themeStore } from "../../lib/themeStore";

// Representative base value per field (picker seeds, hex placeholders, contrast).
export const FIELD_DEFAULT: Record<string, string> = {};
THEME_SCHEMA.forEach((g) => g.fields.forEach((f) => { if (f.default != null) FIELD_DEFAULT[f.key] = String(f.default); }));

// Foreground → background pairs we live-check for legibility (WCAG).
export const CONTRAST_PAIRS: Record<string, string> = {
  "--text": "--bg",
  "--text-dim": "--surface-1",
  "--reader-text": "--reader-bg",
};

// Which region of the live specimen a control governs. Drives both the hover→specimen
// glow AND the reverse "click specimen → jump to that control" targeting.
export function glowFor(key: string): string {
  if (key === "--accent" || key === "--selection-bg") return "accent";
  if (key === "--bg") return "bg";
  if (key === "--border") return "border";
  if (key === "--glass" || key.startsWith("--surface")) return "surface";
  if (key.startsWith("--reader")) return "reader";
  if (key.startsWith("--graph")) return "graph";
  if (key.startsWith("--text")) return "text";
  if (key === "--font-ui" || key === "--ui-scale" || key === "--ui-weight") return "title";
  if (key === "--radius-scale") return "card";
  if (key.startsWith("--ct-") || key === "--shadow-2") return "fx";
  return "";
}

// Palette history — a small persisted ring of recent palettes so a destructive
// "apply preset / surprise / reset" is always one click recoverable.
export interface PaletteEntry { id: string; tokens: Record<string, string>; at: number; }
const HISTORY_KEY = "loom.theme.paletteHistory";
const HISTORY_MAX = 8;

export interface ThemeStudioApi {
  loaded: boolean;
  enabled: boolean;
  themes: CustomTheme[];
  activeId: string | null;
  current: CustomTheme | null;
  tokens: Record<string, string>;
  overrideCount: number;
  effective: (key: string) => string;
  history: PaletteEntry[];
  toggleEnabled: (on: boolean) => void;
  selectTheme: (id: string) => void;
  addTheme: () => void;
  duplicate: () => void;
  rename: () => Promise<void>;
  del: () => Promise<void>;
  reset: () => Promise<void>;
  updateToken: (key: string, value: string | null) => void;
  applyPreset: (p: ThemePreset) => Promise<void>;
  surprise: () => void;
  exportTheme: () => Promise<void>;
  importTheme: () => Promise<void>;
  copyCss: () => Promise<void>;
  restoreHistory: (e: PaletteEntry) => void;
}

export function useThemeStudio(): ThemeStudioApi {
  const { toast } = useLoom();
  const modal = useModal();
  const [enabled, setEnabled] = useState(false);
  const [themes, setThemes] = useState<CustomTheme[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [history, setHistory] = useState<PaletteEntry[]>([]);

  const current = themes.find((t) => t.id === activeId) || null;

  useEffect(() => {
    getCustomThemeState().then((st) => {
      let list = st.themes, aid = st.activeId;
      if (list.length === 0) { const t = newTheme("My theme"); list = [t]; aid = t.id; }
      setThemes(list); setActiveId(aid); setEnabled(st.enabled); setLoaded(true);
    });
    getSetting(HISTORY_KEY).then((raw) => {
      if (!raw) return;
      try { const p = JSON.parse(raw); if (Array.isArray(p)) setHistory(p.slice(0, HISTORY_MAX)); } catch { /* corrupt → ignore */ }
    });
  }, []);

  // Live preview — re-apply to the running app whenever toggle, active theme, or tokens change.
  useEffect(() => {
    if (!loaded) return;
    themeStore.setCustomTheme(themes.find((t) => t.id === activeId) || null, enabled);
  }, [loaded, enabled, activeId, themes]);

  // Persist token edits, debounced — a slider drag must not hammer the settings table.
  const saveTimer = useRef<number | undefined>(undefined);
  // ponytail: track pending save so unmount can flush it before the timer fires
  const pendingSave = useRef<{ themes: CustomTheme[] } | null>(null);
  useEffect(() => {
    if (!loaded) return;
    pendingSave.current = { themes };
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { saveCustomThemes(themes); pendingSave.current = null; }, 300);
    return () => window.clearTimeout(saveTimer.current);
  }, [themes, loaded]);
  // Flush any debounce-pending save when ThemeStudio closes (prevents data loss on fast close).
  useEffect(() => () => { if (pendingSave.current) saveCustomThemes(pendingSave.current.themes); }, []);

  const patchCurrent = useCallback((tokens: Record<string, string>) => {
    setThemes((prev) => prev.map((t) => (t.id === activeId ? { ...t, tokens } : t)));
  }, [activeId]);

  const updateToken = useCallback((key: string, value: string | null) => {
    setThemes((prev) => prev.map((t) => {
      if (t.id !== activeId) return t;
      const tokens = { ...t.tokens };
      if (value == null || value === "") delete tokens[key]; else tokens[key] = value;
      return { ...t, tokens };
    }));
  }, [activeId]);

  // Snapshot the current palette into history before a wholesale replace, so the user
  // can always step back. Dedupes against the most recent entry; persisted best-effort.
  const snapshot = useCallback((tokens: Record<string, string>) => {
    if (!tokens || Object.keys(tokens).length === 0) return;
    setHistory((prev) => {
      const json = JSON.stringify(tokens);
      if (prev[0] && JSON.stringify(prev[0].tokens) === json) return prev;
      const next = [{ id: "ph_" + Date.now().toString(36), tokens, at: Date.now() }, ...prev].slice(0, HISTORY_MAX);
      setSetting(HISTORY_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const toggleEnabled = (on: boolean) => { setEnabled(on); setCustomThemeEnabled(on); };
  const selectTheme = (id: string) => { setActiveId(id); setActiveCustomTheme(id); };
  const addTheme = () => { const t = newTheme(`Theme ${themes.length + 1}`); setThemes([...themes, t]); selectTheme(t.id); };
  const duplicate = () => {
    if (!current) return;
    const t: CustomTheme = { ...newTheme(`${current.name} copy`), tokens: { ...current.tokens } };
    setThemes([...themes, t]); selectTheme(t.id);
  };
  const rename = async () => {
    if (!current) return;
    const r = await modal.form({ panel: true, title: "Rename theme", icon: "ph-pencil", accent: "var(--accent)", submitLabel: "Rename", fields: [{ name: "name", label: "Name", defaultValue: current.name, required: true }] });
    if (!r) return;
    setThemes(themes.map((t) => (t.id === current.id ? { ...t, name: r.name } : t)));
  };
  const del = async () => {
    if (!current) return;
    const ok = await modal.confirm({ title: "Delete theme", message: `Delete "${current.name}"?`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    const list = themes.filter((t) => t.id !== current.id);
    if (list.length === 0) { const t = newTheme("My theme"); setThemes([t]); selectTheme(t.id); }
    else { setThemes(list); selectTheme(list[0].id); }
  };
  const reset = async () => {
    if (!current) return;
    const ok = await modal.confirm({ title: "Reset theme", message: `Clear all ${overrideCount} override${overrideCount === 1 ? "" : "s"} in "${current.name}"?`, icon: "ph-arrow-counter-clockwise", danger: true, confirmLabel: "Reset" });
    if (!ok) return;
    snapshot(current.tokens);
    patchCurrent({});
    toast("Theme reset to defaults", "ph-arrow-counter-clockwise");
  };

  const applyPreset = async (p: ThemePreset) => {
    if (!current) return;
    const ok = await modal.confirm({ title: `Apply "${p.name}"?`, message: `Replace all token overrides in "${current.name}"?`, icon: "ph-magic-wand", confirmLabel: "Apply" });
    if (!ok) return;
    snapshot(current.tokens);
    patchCurrent({ ...p.tokens });
    if (!enabled) toggleEnabled(true);
    toast(`Applied "${p.name}"`, "ph-magic-wand");
  };
  const surprise = () => {
    if (!current) return;
    snapshot(current.tokens);
    patchCurrent({ ...randomTheme().tokens });
    if (!enabled) toggleEnabled(true);
    toast("Rolled a new look", "ph-shuffle");
  };
  const restoreHistory = (e: PaletteEntry) => {
    if (!current) return;
    snapshot(current.tokens);
    patchCurrent({ ...e.tokens });
    if (!enabled) toggleEnabled(true);
    toast("Palette restored", "ph-clock-counter-clockwise");
  };

  const exportTheme = async () => {
    if (!current) return;
    const safe = current.name.replace(/[^\w-]+/g, "_") || "theme";
    try {
      const path = await save({ defaultPath: `${safe}.loomtheme.json`, filters: [{ name: "LOOM theme", extensions: ["json"] }] });
      if (!path) return;
      await fsWriteAnyFile(path, serializeTheme(current));
      toast("Theme exported", "ph-download-simple");
    } catch (e) { console.error("Theme export failed:", e); toast("Export failed  -  check file permissions", "ph-warning"); }
  };
  const importTheme = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "LOOM theme", extensions: ["json"] }] });
      if (!sel || typeof sel !== "string") return;
      const t = parseTheme(await fsReadNoteContent(sel));
      setThemes((prev) => [...prev, t]); selectTheme(t.id);
      if (!enabled) toggleEnabled(true);
      toast(`Imported "${t.name}"`, "ph-upload-simple");
    } catch (e) {
      console.error("Theme import failed:", e);
      modal.confirm({ title: "Import failed", message: String(e), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    }
  };
  const copyCss = async () => {
    if (!current) return;
    try { await navigator.clipboard.writeText(themeToCss(tokens)); toast("CSS variables copied to clipboard", "ph-clipboard-text"); }
    catch { toast("Clipboard unavailable", "ph-warning"); }
  };

  const tokens = current?.tokens || {};
  const overrideCount = Object.keys(tokens).length;
  const effective = (key: string) => tokens[key] || FIELD_DEFAULT[key];

  return {
    loaded, enabled, themes, activeId, current, tokens, overrideCount, effective, history,
    toggleEnabled, selectTheme, addTheme, duplicate, rename, del, reset,
    updateToken, applyPreset, surprise, exportTheme, importTheme, copyCss, restoreHistory,
  };
}
