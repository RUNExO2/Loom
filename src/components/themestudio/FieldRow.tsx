import { cx, I } from "../../lib/context";
import { ThemeField } from "../../lib/theme";
import { FIELD_DEFAULT, glowFor } from "./state";

// One control row: color / scale / select / text. Hovering or focusing it glows the
// region it governs in the live specimen (onHover). The row carries an id so the reverse
// targeting (click specimen → jump here) can scroll + focus it.
export function FieldRow({ field, value, contrast, onChange, onHover }: {
  field: ThemeField;
  value: string | undefined;
  contrast: { label: string; pass: boolean; ratio: number } | null;
  onChange: (v: string | null) => void;
  onHover: (key: string | null) => void;
}) {
  const set = value !== undefined && value !== "";
  const def = FIELD_DEFAULT[field.key];
  // Font family: free-text entry (any installed font) with the curated families as a
  // native datalist of suggestions. ponytail: @font-face file embedding skipped — add
  // when someone needs a font that isn't installed system-wide.
  const isFont = field.key === "--font-ui";
  return (
    <div
      id={"ts-field-" + field.key}
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

      {field.type === "select" && !isFont && (
        <select className="ts-fsel" value={set ? value! : ""} onChange={(e) => onChange(e.target.value || null)} aria-label={field.label}>
          <option value="">Default</option>
          {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}

      {field.type === "select" && isFont && (
        <div className="ts-ctl">
          <input
            type="text" list="ts-font-suggestions" className="ts-hex" style={{ width: 150 }} spellCheck={false}
            value={set ? value! : ""} placeholder="default — type any font"
            onChange={(e) => onChange(e.target.value || null)} aria-label={field.label}
          />
          <datalist id="ts-font-suggestions">
            {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </datalist>
          <ResetBtn show={set} onReset={() => onChange(null)} />
        </div>
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
