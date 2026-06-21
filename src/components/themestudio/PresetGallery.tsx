import { I } from "../../lib/context";
import { THEME_PRESETS, ThemePreset, themeSwatch } from "../../lib/theme";

// Curated preset cards — one click applies a complete look (confirmed in state.applyPreset).
export function PresetGallery({ onApply }: { onApply: (p: ThemePreset) => void }) {
  return (
    <div className="ts-group" style={{ marginTop: 10 }}>
      <div className="ts-group-h"><I n="ph-stack" /> Presets</div>
      <div className="ts-presets">
        {THEME_PRESETS.map((p) => {
          const sw = themeSwatch(p.tokens);
          return (
            <button key={p.name} className="ts-preset" onClick={() => onApply(p)} title={`Apply "${p.name}"`}>
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
  );
}
