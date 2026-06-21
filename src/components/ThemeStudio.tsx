import { useState } from "react";
import * as Switch from "@radix-ui/react-switch";
import { I } from "../lib/context";
import { THEME_SCHEMA } from "../lib/theme";
import { OverlayShell } from "./ui/OverlayShell";
import { useThemeStudio, glowFor } from "./themestudio/state";
import { Toolbar } from "./themestudio/Toolbar";
import { PresetGallery } from "./themestudio/PresetGallery";
import { BackgroundPanel } from "./themestudio/BackgroundPanel";
import { NavPanel } from "./themestudio/NavPanel";
import { PaletteHistory } from "./themestudio/PaletteHistory";
import { TokenControls } from "./themestudio/TokenControls";
import { DiagnosticsPanel } from "./themestudio/DiagnosticsPanel";
import { LivePreview } from "./themestudio/LivePreview";

// Full theme customiser. A thin composition shell: all state/logic lives in
// useThemeStudio (state.ts), each pane is its own focused component. Edits live-apply to
// the running app (no restart) and stream into the on-canvas specimen.
export function ThemeStudio({ onClose }: { onClose: () => void }) {
  const s = useThemeStudio();
  const [hi, setHi] = useState<string | null>(null);   // highlighted specimen region

  // Reverse targeting: click a specimen region → scroll to + focus the first control that
  // governs it, and flash its glow so the link is obvious.
  const targetRegion = (region: string) => {
    for (const group of THEME_SCHEMA) {
      for (const f of group.fields) {
        if (glowFor(f.key) !== region) continue;
        const el = document.getElementById("ts-field-" + f.key);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        (el.querySelector("input, select") as HTMLElement | null)?.focus();
        setHi(region);
        window.setTimeout(() => setHi((cur) => (cur === region ? null : cur)), 1200);
        return;
      }
    }
  };

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
            <span className="lbl" style={{ color: s.enabled ? "var(--accent-text)" : "var(--text-faint)" }}>{s.enabled ? "On" : "Off"}</span>
            <Switch.Root className="rx-switch" checked={s.enabled} onCheckedChange={s.toggleEnabled} aria-label="Apply custom theme to the app">
              <Switch.Thumb className="rx-switch-thumb" />
            </Switch.Root>
          </div>
          <button className="btn icon sm" onClick={onClose} aria-label="Close Theme Studio"><I n="ph-x" /></button>
        </div>

        <Toolbar s={s} />

        {!s.enabled && (
          <div className="ts-banner">
            <I n="ph-info" /> The specimen always previews this theme. Flip <strong>On</strong> to paint the rest of the app too.
          </div>
        )}

        {/* Two-pane body: controls | living specimen */}
        <div className="ts-body">
          <div className="ts-controls">
            <PresetGallery presets={s.themes} activeId={s.activeId} onSelect={s.selectTheme} />
            <PaletteHistory history={s.history} onRestore={s.restoreHistory} />
            <BackgroundPanel />
            <NavPanel />
            <TokenControls tokens={s.tokens} effective={s.effective} updateToken={s.updateToken} onHover={setHi} />
            <DiagnosticsPanel tokens={s.tokens} />
          </div>

          {/* Living specimen */}
          <aside className="ts-aside">
            <LivePreview tokens={s.tokens} hi={hi} onTarget={targetRegion} />
            <div className="ts-legend mono-sm ghost">
              Hover a control to glow its region  -  or click the specimen to jump to its control.
            </div>
          </aside>
        </div>

        {/* Footer actions */}
        <div className="ts-foot">
          <span className="cnt"><I n="ph-circle-half" /> {s.overrideCount} token{s.overrideCount === 1 ? "" : "s"} overridden</span>
          <span className="ts-spacer" />
          <button className="btn sm" onClick={s.reset} title="Clear all overrides in this theme"><I n="ph-arrow-counter-clockwise" /> Reset</button>
          <button className="btn sm" onClick={s.copyCss} title="Copy theme as CSS variables"><I n="ph-clipboard-text" /> Copy CSS</button>
          <button className="btn sm" onClick={s.importTheme}><I n="ph-upload-simple" /> Import</button>
          <button className="btn sm" onClick={s.exportThemeCss}><I n="ph-download-simple" /> Export CSS</button>
          <button className="btn sm primary" onClick={s.exportTheme}><I n="ph-download-simple" /> Export JSON</button>
        </div>
      </div>
    </OverlayShell>
  );
}
