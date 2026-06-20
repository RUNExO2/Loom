import { useEffect, useState, useCallback, useRef } from "react";
import * as Switch from "@radix-ui/react-switch";
import { I, cx, useLoom } from "../lib/context";
import { OverlayShell } from "./ui/OverlayShell";
import { useModal } from "./Modal";
import {
  THEME_SCHEMA, ThemeField, CustomTheme, MANAGED_VAR_KEYS,
  getCustomThemeState, saveCustomThemes, setCustomThemeEnabled, setActiveCustomTheme,
  applyCustomTheme, newTheme, serializeTheme, parseTheme, composeFilter,
  THEME_PRESETS, ThemePreset, randomTheme,
  contrastRatio, wcagRating, themeSwatch, themeToCss,
} from "../lib/theme";
import { save, open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { fsWriteAnyFile, fsReadNoteContent } from "../ipc/fs";
import { getBackgroundConfig, setBackgroundConfig, BackgroundConfig, applyBackgroundConfig } from "../lib/settings";
import { processBackground } from "../lib/backgroundEngine";

// Representative base value per field (for picker seeds, hex placeholders, contrast).
const FIELD_DEFAULT: Record<string, string> = {};
THEME_SCHEMA.forEach((g) => g.fields.forEach((f) => { if (f.default != null) FIELD_DEFAULT[f.key] = String(f.default); }));

// Foreground → background pairs we live-check for legibility (WCAG).
const CONTRAST_PAIRS: Record<string, string> = {
  "--text": "--bg",
  "--text-dim": "--surface-1",
  "--reader-text": "--reader-bg",
};

// Which region of the live specimen a given control governs  -  drives the focus glow.
function glowFor(key: string): string {
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

// Full theme customiser. Edits live-apply to the running app (no restart) and stream into
// the on-canvas specimen; disabling instantly reverts to the active base theme.
export function ThemeStudio({ onClose }: { onClose: () => void }) {
  const { toast, navStyle, setNavStyle } = useLoom();
  const modal = useModal();
  const [enabled, setEnabled] = useState(false);
  const [themes, setThemes] = useState<CustomTheme[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [hi, setHi] = useState<string | null>(null);   // highlighted region in the specimen
  const [bg, setBg] = useState<BackgroundConfig | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const current = themes.find((t) => t.id === activeId) || null;

  useEffect(() => {
    getCustomThemeState().then((st) => {
      let list = st.themes, aid = st.activeId;
      if (list.length === 0) { const t = newTheme("My theme"); list = [t]; aid = t.id; }
      setThemes(list); setActiveId(aid); setEnabled(st.enabled); setLoaded(true);
    });
    getBackgroundConfig().then(setBg);
  }, []);

  // Live preview  -  re-apply to the running app whenever toggle, active theme, or tokens change.
  useEffect(() => {
    if (!loaded) return;
    applyCustomTheme(themes.find((t) => t.id === activeId) || null, enabled);
  }, [loaded, enabled, activeId, themes]);

  // Persist token edits, debounced  -  a slider drag must not hammer the settings table.
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveCustomThemes(themes), 300);
    return () => window.clearTimeout(saveTimer.current);
  }, [themes, loaded]);

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
  const reset = () => {
    if (!current) return;
    patchCurrent({});
    toast("Theme reset to defaults", "ph-arrow-counter-clockwise");
  };

  const applyPreset = (p: ThemePreset) => {
    if (!current) return;
    patchCurrent({ ...p.tokens });
    if (!enabled) toggleEnabled(true);
    toast(`Applied "${p.name}"`, "ph-magic-wand");
  };
  const surprise = () => {
    if (!current) return;
    patchCurrent({ ...randomTheme().tokens });
    if (!enabled) toggleEnabled(true);
    toast("Rolled a new look", "ph-shuffle");
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
      setThemes([...themes, t]); selectTheme(t.id);
      if (!enabled) toggleEnabled(true);
      toast(`Imported "${t.name}"`, "ph-upload-simple");
    } catch (e) {
      console.error("Theme import failed:", e);
      modal.confirm({ title: "Import failed", message: String(e), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    }
  };

  const handlePickBg = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }] });
      if (!sel || typeof sel !== "string") return;
      setIsProcessing(true);
      const url = convertFileSrc(sel);
      try {
        const profile = await processBackground(url);
        const newBg = { ...bg!, bgImage: sel, profile };
        setBg(newBg);
        await setBackgroundConfig(newBg);
        applyBackgroundConfig(newBg);
        toast("Background processed and applied", "ph-image");
      } catch (err) {
        toast("Failed to process image", "ph-warning");
      } finally {
        setIsProcessing(false);
      }
    } catch {}
  };

  const updateBg = async (patch: Partial<BackgroundConfig>) => {
    if (!bg) return;
    const newBg = { ...bg, ...patch };
    setBg(newBg);
    await setBackgroundConfig(newBg);
    applyBackgroundConfig(newBg);
  };

  const clearBg = async () => {
    if (!bg) return;
    const newBg = { ...bg, bgImage: null, profile: null };
    setBg(newBg);
    await setBackgroundConfig(newBg);
    applyBackgroundConfig(newBg);
  };

  const copyCss = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(themeToCss(tokens));
      toast("CSS variables copied to clipboard", "ph-clipboard-text");
    } catch { toast("Clipboard unavailable", "ph-warning"); }
  };

  const tokens = current?.tokens || {};
  const overrideCount = Object.keys(tokens).length;
  const effective = (key: string) => tokens[key] || FIELD_DEFAULT[key];

  return (
    <OverlayShell onClose={onClose} title="Theme Studio" align="top">
      <div className="ts-shell">
        {/* Header + master enable toggle */}
        <div className="ts-head">
          <div className="vault-ico" style={{ "--mod": "var(--accent)", width: 36, height: 36 } as any}><I n="ph-paint-brush-broad" w="fill" /></div>
          <div className="ts-h-tx">
            <div className="t">Theme Studio</div>
            <div className="s">Sculpt every design token. Every change repaints the specimen live.</div>
          </div>
          <div className="ts-master">
            <span className="lbl" style={{ color: enabled ? "var(--accent-text)" : "var(--text-faint)" }}>{enabled ? "On" : "Off"}</span>
            <Switch.Root className="rx-switch" checked={enabled} onCheckedChange={toggleEnabled} aria-label="Apply custom theme to the app">
              <Switch.Thumb className="rx-switch-thumb" />
            </Switch.Root>
          </div>
          <button className="btn icon sm" onClick={onClose} aria-label="Close Theme Studio"><I n="ph-x" /></button>
        </div>

        {/* Theme management toolbar */}
        <div className="ts-toolbar">
          <select value={activeId ?? ""} onChange={(e) => selectTheme(e.target.value)} className="ts-sel" aria-label="Active theme">
            {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button className="btn sm" onClick={addTheme} title="New theme"><I n="ph-plus" /> New</button>
          <button className="btn icon sm" onClick={duplicate} title="Duplicate" aria-label="Duplicate theme"><I n="ph-copy" /></button>
          <button className="btn icon sm" onClick={rename} title="Rename" aria-label="Rename theme"><I n="ph-pencil" /></button>
          <button className="btn icon sm" onClick={del} title="Delete theme" aria-label="Delete theme"><I n="ph-trash" /></button>
          <span className="ts-spacer" />
          <button className="btn sm" onClick={surprise} title="Generate a random harmonious theme"><I n="ph-shuffle" /> Surprise me</button>
        </div>

        {!enabled && (
          <div className="ts-banner">
            <I n="ph-info" /> The specimen always previews this theme. Flip <strong>On</strong> to paint the rest of the app too.
          </div>
        )}

        {/* Two-pane body: controls | living specimen */}
        <div className="ts-body">
          <div className="ts-controls">
            {/* Preset gallery */}
            <div className="ts-group" style={{ marginTop: 10 }}>
              <div className="ts-group-h"><I n="ph-stack" /> Presets</div>
              <div className="ts-presets">
                {THEME_PRESETS.map((p) => {
                  const sw = themeSwatch(p.tokens);
                  return (
                    <button key={p.name} className="ts-preset" onClick={() => applyPreset(p)} title={`Apply "${p.name}"`}>
                      <div className="ts-preset-pal">
                        <div style={{ background: sw.bg }} />
                        <div style={{ background: sw.surface }} />
                        <div style={{ background: sw.accent }} />
                        <div style={{ background: sw.text }} />
                      </div>
                      <div className="ts-preset-nm">{p.name}</div>
                      <div className="ts-preset-bl">{p.blurb}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Background System */}
            {bg && (
              <div className="ts-group">
                <div className="ts-group-h"><I n="ph-image" /> Background System</div>
                
                <div className="ts-field">
                  <div className="ts-field-tx">
                    <div className="l">Background Image</div>
                    <div className="h">Select an image for the Premium Background Engine.</div>
                  </div>
                  <div className="ts-ctl" style={{ gap: 8 }}>
                    {isProcessing ? <span className="mono-sm ghost">Processing...</span> :
                     bg.bgImage ? (
                      <>
                        <span className="mono-sm" title={bg.bgImage} style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {bg.bgImage.split(/[\/\\]/).pop()}
                        </span>
                        <button className="btn sm" onClick={clearBg} title="Remove background"><I n="ph-x" /> Clear</button>
                      </>
                    ) : (
                      <button className="btn sm" onClick={handlePickBg}><I n="ph-image" /> Browse</button>
                    )}
                  </div>
                </div>

                <div className="ts-field">
                  <div className="ts-field-tx">
                    <div className="l">Readability Engine</div>
                    <div className="h">Dynamic background blurring and darkening for UI contrast.</div>
                  </div>
                  <Switch.Root className="rx-switch" checked={bg.bgDynamic} onCheckedChange={(v) => updateBg({ bgDynamic: v })} disabled={!bg.bgImage}>
                    <Switch.Thumb className="rx-switch-thumb" />
                  </Switch.Root>
                </div>

                <div className="ts-field">
                  <div className="ts-field-tx">
                    <div className="l">Extract Palette</div>
                    <div className="h">Use image colors for the app accent and surface tint.</div>
                  </div>
                  <div className="ts-ctl">
                    <button className={cx("btn sm", bg.bgUseColors && "active")} onClick={() => updateBg({ bgUseColors: !bg.bgUseColors })}>
                      <I n={bg.bgUseColors ? "ph-check-circle" : "ph-circle"} /> Extract Colors
                    </button>
                  </div>
                </div>

                <div className="ts-field">
                  <div className="ts-field-tx">
                    <div className="l">Enable Parallax</div>
                    <div className="h">Slightly shift the background with mouse movement.</div>
                  </div>
                  <Switch.Root className="rx-switch" checked={bg.bgParallax} onCheckedChange={(v) => updateBg({ bgParallax: v })} disabled={!bg.bgImage}>
                    <Switch.Thumb className="rx-switch-thumb" />
                  </Switch.Root>
                </div>
              </div>
            )}

            {/* Navigation System */}
            <div className="ts-group">
              <div className="ts-group-h"><I n="ph-layout" /> Navigation System</div>
              <div className="ts-field">
                <div className="ts-field-tx">
                  <div className="l">Navigation Style</div>
                  <div className="h">Choose between a traditional sidebar or compact titlebar pills.</div>
                </div>
                <div className="ts-ctl" style={{ gap: 8 }}>
                  <div className="modal-seg">
                    <button className={cx(navStyle === "sidebar" && "on")} onClick={() => { setNavStyle("sidebar"); }}>
                      <I n="ph-sidebar-simple" /> Sidebar
                    </button>
                    <button className={cx(navStyle === "top-pill" && "on")} onClick={() => { setNavStyle("top-pill"); }}>
                      <I n="ph-browser" /> Top Pills
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Token groups */}
            {THEME_SCHEMA.map((group) => (
              <div key={group.title} className="ts-group">
                <div className="ts-group-h"><I n={group.icon} /> {group.title}</div>
                {group.fields.map((f) => {
                  let contrast: { label: string; pass: boolean; ratio: number } | null = null;
                  const pairKey = CONTRAST_PAIRS[f.key];
                  if (pairKey) {
                    const r = contrastRatio(effective(f.key), effective(pairKey));
                    if (r != null) contrast = { ...wcagRating(r), ratio: r };
                  }
                  return (
                    <FieldRow
                      key={f.key} field={f} value={tokens[f.key]} contrast={contrast}
                      onChange={(v) => updateToken(f.key, v)} onHover={setHi}
                    />
                  );
                })}
              </div>
            ))}
          </div>

          {/* Living specimen */}
          <aside className="ts-aside">
            <LivePreview tokens={tokens} hi={hi} />
            <div className="ts-legend mono-sm ghost">
              Touch a control  -  the part it governs glows here.
            </div>
          </aside>
        </div>

        {/* Footer actions */}
        <div className="ts-foot">
          <span className="cnt"><I n="ph-circle-half" /> {overrideCount} token{overrideCount === 1 ? "" : "s"} overridden</span>
          <span className="ts-spacer" />
          <button className="btn sm" onClick={reset} title="Clear all overrides in this theme"><I n="ph-arrow-counter-clockwise" /> Reset</button>
          <button className="btn sm" onClick={copyCss} title="Copy theme as CSS variables"><I n="ph-clipboard-text" /> Copy CSS</button>
          <button className="btn sm" onClick={importTheme}><I n="ph-upload-simple" /> Import</button>
          <button className="btn sm primary" onClick={exportTheme}><I n="ph-download-simple" /> Export</button>
        </div>
      </div>
    </OverlayShell>
  );
}

// ── Living specimen  -  a miniature LOOM that re-paints from the edited tokens ──────────
function LivePreview({ tokens, hi }: { tokens: Record<string, string>; hi: string | null }) {
  const vars: Record<string, string> = {};
  for (const k of MANAGED_VAR_KEYS) { const v = tokens[k]; if (v) vars[k] = v; }
  const filter = composeFilter(tokens);
  const screenStyle = { ...vars, ...(filter ? { filter } : {}) } as any;
  const g = (name: string) => (hi === name ? " ts-glow" : "");

  return (
    <div className="ts-stage">
      <div className="ts-stage-label mono-sm ghost">Live specimen</div>
      <div className={"tsp-screen" + g("bg") + g("fx")} style={screenStyle}>
        <div className="tsp-bar">
          <span className="tsp-dots"><i /><i /><i /></span>
          <span className={"tsp-wm" + g("title")}>LOOM</span>
          <span className="tsp-search" />
        </div>
        <div className="tsp-body">
          <div className="tsp-side">
            <span className="tsp-nav on"><I n="ph-squares-four" /> Home</span>
            <span className="tsp-nav"><I n="ph-note" /> Notes</span>
            <span className="tsp-nav"><I n="ph-check-square" /> Tasks</span>
          </div>
          <div className="tsp-main">
            <span className="tsp-kicker">Workspace</span>
            <span className={"tsp-title" + g("title") + g("text")}>Good evening</span>

            <div className={"tsp-card" + g("surface") + g("border") + g("card")}>
              <div className="tsp-card-h">
                <span className="tsp-ico"><I n="ph-target" w="fill" /></span>
                <span className="tsp-card-t">Today</span>
                <span className="tsp-count">2 / 3</span>
              </div>
              <div className="tsp-row"><span className="tsp-chk on"><I n="ph-check" w="bold" /></span> Ship the theme studio</div>
              <div className="tsp-row"><span className="tsp-chk" /> Review pull request</div>
              <div className="tsp-bar2"><i /></div>
            </div>

            <div className={"tsp-actions" + g("accent")}>
              <span className="tsp-btn pri">Save</span>
              <span className="tsp-btn gh">Cancel</span>
              <span className="tsp-tag">focus</span>
              <span className="tsp-toggle"><i /></span>
            </div>

            <div className={"tsp-reader" + g("reader")}>Reading view  -  calm long-form text.</div>
            <div className={"tsp-graph" + g("graph")}><span className="nd" /><span className="ed" /><span className="nd" /><span className="ed" /><span className="nd" /></div>
            <div className="tsp-seltx">Select <span className={"tsp-sel" + g("accent")}>this highlight</span> sample.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldRow({ field, value, contrast, onChange, onHover }: {
  field: ThemeField;
  value: string | undefined;
  contrast: { label: string; pass: boolean; ratio: number } | null;
  onChange: (v: string | null) => void;
  onHover: (key: string | null) => void;
}) {
  const set = value !== undefined && value !== "";
  const def = FIELD_DEFAULT[field.key];
  return (
    <div
      className="ts-field"
      onMouseEnter={() => onHover(glowFor(field.key))}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(glowFor(field.key))}
      onBlur={() => onHover(null)}
    >
      <div className="ts-field-tx">
        <div className="l">{field.label}</div>
        {field.hint && <div className="h">{field.hint}</div>}
      </div>

      {field.type === "color" && (
        <div className="ts-ctl">
          <label className="ts-color" style={{ background: set ? value : def, opacity: set ? 1 : 0.6 }} title={set ? value : "Using base theme"}>
            <input
              type="color"
              value={set && value!.startsWith("#") ? value! : (def && def.startsWith("#") ? def : "#888888")}
              onChange={(e) => onChange(e.target.value)}
              aria-label={`${field.label} color`}
            />
          </label>
          <input
            type="text" className="ts-hex" spellCheck={false} value={set ? value! : ""} placeholder={def || "default"}
            onChange={(e) => onChange(e.target.value || null)} aria-label={`${field.label} value`}
          />
          {contrast && (
            <span className={cx("ts-badge", contrast.pass ? "ok" : "bad")} title={`Contrast ${contrast.ratio.toFixed(2)}:1 vs its background`}>
              {contrast.label}
            </span>
          )}
          <ResetBtn show={set} onReset={() => onChange(null)} />
        </div>
      )}

      {field.type === "scale" && (
        <div className="ts-ctl">
          <input
            type="range" className="ts-range" min={field.min} max={field.max} step={field.step}
            value={parseFloat(set ? value! : String(field.default))}
            onChange={(e) => onChange(e.target.value)} aria-label={field.label}
          />
          <span className="ts-num">{(set ? value : String(field.default))}{field.unit || ""}</span>
          <ResetBtn show={set} onReset={() => onChange(null)} />
        </div>
      )}

      {field.type === "select" && (
        <select className="ts-fsel" value={set ? value! : ""} onChange={(e) => onChange(e.target.value || null)} aria-label={field.label}>
          <option value="">Default</option>
          {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}

      {field.type === "text" && (
        <div className="ts-ctl">
          <input
            type="text" className="ts-hex" style={{ width: 150 }} value={set ? value! : ""} placeholder="default"
            onChange={(e) => onChange(e.target.value || null)} aria-label={field.label}
          />
          <ResetBtn show={set} onReset={() => onChange(null)} />
        </div>
      )}
    </div>
  );
}

function ResetBtn({ show, onReset }: { show: boolean; onReset: () => void }) {
  if (!show) return <span style={{ width: 24, flex: "0 0 24px" }} />;
  return (
    <button className="btn icon sm" onClick={onReset} title="Reset to default" aria-label="Reset to default" style={{ width: 24, height: 24, padding: 0, flex: "0 0 24px" }}>
      <I n="ph-arrow-counter-clockwise" style={{ fontSize: "var(--fs-sm)" }} />
    </button>
  );
}
