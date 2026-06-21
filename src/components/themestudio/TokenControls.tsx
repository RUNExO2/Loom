import { I } from "../../lib/context";
import { THEME_SCHEMA, contrastRatio, wcagRating } from "../../lib/theme";
import { FieldRow } from "./FieldRow";
import { CONTRAST_PAIRS } from "./state";

// Schema-driven token editor: every group/field comes from THEME_SCHEMA, so adding a
// token is a one-line schema entry — no change here.
export function TokenControls({ tokens, effective, updateToken, onHover }: {
  tokens: Record<string, string>;
  effective: (key: string) => string;
  updateToken: (key: string, value: string | null) => void;
  onHover: (key: string | null) => void;
}) {
  return (
    <>
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
                onChange={(v) => updateToken(f.key, v)} onHover={onHover}
              />
            );
          })}
        </div>
      ))}
    </>
  );
}
