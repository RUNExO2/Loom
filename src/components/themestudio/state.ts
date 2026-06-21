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
import { getSetting, setSetting, saveThemePreset, deleteThemePreset, duplicateThemePreset, renameThemePreset } from "../../ipc/items";
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
  exportThemeCss: () => Promise<void>;
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

  // Persist active theme edits, debounced to SQLite database
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingSave = useRef<CustomTheme | null>(null);

  const saveActiveTheme = useCallback(async (theme: CustomTheme) => {
    try {
      await saveThemePreset({
        id: theme.id,
        name: theme.name,
        blurb: theme.blurb,
        tokens: JSON.stringify(theme.tokens),
      });
    } catch (e) {
      console.error("Failed to save theme preset:", e);
    }
  }, []);

  useEffect(() => {
    if (!loaded || !current) return;
    pendingSave.current = current;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      if (pendingSave.current) {
        await saveActiveTheme(pendingSave.current);
        pendingSave.current = null;
      }
    }, 300);
    return () => window.clearTimeout(saveTimer.current);
  }, [current, loaded, saveActiveTheme]);

  // Flush any pending save when ThemeStudio closes
  useEffect(() => () => {
    if (pendingSave.current) {
      saveActiveTheme(pendingSave.current);
    }
  }, [saveActiveTheme]);

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
  const addTheme = async () => {
    const t = newTheme(`Theme ${themes.length + 1}`);
    try {
      await saveThemePreset({
        id: t.id,
        name: t.name,
        blurb: t.blurb,
        tokens: JSON.stringify(t.tokens),
      });
      setThemes((prev) => [...prev, t]);
      selectTheme(t.id);
    } catch (e) {
      toast("Failed to create theme preset", "ph-warning");
    }
  };
  const duplicate = async () => {
    if (!current) return;
    const newId = newThemeId();
    const newName = `${current.name} copy`;
    try {
      await duplicateThemePreset(current.id, newId, newName);
      const t: CustomTheme = {
        id: newId,
        name: newName,
        blurb: current.blurb,
        tokens: { ...current.tokens },
      };
      setThemes((prev) => [...prev, t]);
      selectTheme(newId);
      toast(`Duplicated "${current.name}"`, "ph-copy");
    } catch (e) {
      toast("Failed to duplicate theme preset", "ph-warning");
    }
  };
  const rename = async () => {
    if (!current) return;
    const r = await modal.form({ panel: true, title: "Rename theme", icon: "ph-pencil", accent: "var(--accent)", submitLabel: "Rename", fields: [{ name: "name", label: "Name", defaultValue: current.name, required: true }] });
    if (!r) return;
    try {
      await renameThemePreset(current.id, r.name);
      setThemes((prev) => prev.map((t) => (t.id === current.id ? { ...t, name: r.name } : t)));
      toast("Theme renamed", "ph-pencil");
    } catch (e) {
      toast("Failed to rename theme preset", "ph-warning");
    }
  };
  const del = async () => {
    if (!current) return;
    const ok = await modal.confirm({ title: "Delete theme", message: `Delete "${current.name}"?`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try {
      await deleteThemePreset(current.id);
      const list = themes.filter((t) => t.id !== current.id);
      if (list.length === 0) {
        const t = newTheme("My theme");
        await saveThemePreset({
          id: t.id,
          name: t.name,
          blurb: t.blurb,
          tokens: JSON.stringify(t.tokens),
        });
        setThemes([t]);
        selectTheme(t.id);
      } else {
        setThemes(list);
        selectTheme(list[0].id);
      }
      toast("Theme deleted", "ph-trash");
    } catch (e) {
      toast("Failed to delete theme preset", "ph-warning");
    }
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
  const exportThemeCss = async () => {
    if (!current) return;
    const safe = current.name.replace(/[^\w-]+/g, "_") || "theme";
    try {
      const path = await save({ defaultPath: `${safe}.theme.css`, filters: [{ name: "CSS Theme", extensions: ["css"] }] });
      if (!path) return;
      await fsWriteAnyFile(path, themeToCss(tokens));
      toast("Theme CSS exported", "ph-download-simple");
    } catch (e) { console.error("Theme CSS export failed:", e); toast("Export failed  -  check file permissions", "ph-warning"); }
  };
  const importTheme = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "LOOM theme", extensions: ["json"] }] });
      if (!sel || typeof sel !== "string") return;
      const t = parseTheme(await fsReadNoteContent(sel));

      // Persist locally in the database and trigger backend validation
      await saveThemePreset({
        id: t.id,
        name: t.name,
        blurb: t.blurb,
        tokens: JSON.stringify(t.tokens),
      });

      setThemes((prev) => [...prev, t]);
      selectTheme(t.id);
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
    updateToken, applyPreset, surprise, exportTheme, exportThemeCss, importTheme, copyCss, restoreHistory,
  };
}
