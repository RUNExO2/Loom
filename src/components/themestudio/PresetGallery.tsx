import { I } from "../../lib/context";
import { ThemePreset, themeSwatch } from "../../lib/theme";

// Curated preset cards — loaded from SQLite database, selecting one activates it.
export function PresetGallery({
  presets,
  activeId,
  onSelect,
}: {
  presets: ThemePreset[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="ts-group" style={{ marginTop: 10 }}>
      <div className="ts-group-h"><I n="ph-stack" /> Presets</div>
      <div className="ts-presets">
        {presets.map((p) => {
          const sw = themeSwatch(p.tokens);
          const isActive = p.id === activeId;
          return (
            <button
              key={p.id}
              className={`ts-preset ${isActive ? "active" : ""}`}
              onClick={() => onSelect(p.id)}
              title={`Select "${p.name}"`}
              style={isActive ? { borderColor: "var(--accent)", background: "var(--surface-hover)" } : undefined}
            >
              <div className="ts-preset-pal">
                <div style={{ background: sw.bg }} />
                <div style={{ background: sw.surface }} />
                <div style={{ background: sw.accent }} />
                <div style={{ background: sw.text }} />
              </div>
              <div className="ts-preset-nm">{p.name}</div>
              <div className="ts-preset-bl">{p.blurb || "Custom theme"}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
