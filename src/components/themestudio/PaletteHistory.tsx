import { I } from "../../lib/context";
import { themeSwatch } from "../../lib/theme";
import { PaletteEntry } from "./state";

// Recently-replaced palettes. Each "apply preset / surprise / reset" snapshots the old
// palette here, so a one-click restore always undoes a regretted change.
export function PaletteHistory({ history, onRestore }: {
  history: PaletteEntry[];
  onRestore: (e: PaletteEntry) => void;
}) {
  if (history.length === 0) return null;
  return (
    <div className="ts-group">
      <div className="ts-group-h"><I n="ph-clock-counter-clockwise" /> Palette History</div>
      <div className="ts-history">
        {history.map((e) => {
          const sw = themeSwatch(e.tokens);
          return (
            <button key={e.id} className="ts-hist" onClick={() => onRestore(e)} title="Restore this palette">
              <div className="ts-hist-pal">
                <div style={{ background: sw.bg }} />
                <div style={{ background: sw.surface }} />
                <div style={{ background: sw.accent }} />
                <div style={{ background: sw.text }} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
