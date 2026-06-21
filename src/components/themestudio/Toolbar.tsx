import { I } from "../../lib/context";
import { ThemeStudioApi } from "./state";

// Theme management row: pick / new / duplicate / rename / delete, plus "Surprise me".
export function Toolbar({ s }: { s: ThemeStudioApi }) {
  return (
    <div className="ts-toolbar">
      <select value={s.activeId ?? ""} onChange={(e) => s.selectTheme(e.target.value)} className="ts-sel" aria-label="Active theme">
        {s.themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <button className="btn sm" onClick={s.addTheme} title="New theme"><I n="ph-plus" /> New</button>
      <button className="btn icon sm" onClick={s.duplicate} title="Duplicate" aria-label="Duplicate theme"><I n="ph-copy" /></button>
      <button className="btn icon sm" onClick={s.rename} title="Rename" aria-label="Rename theme"><I n="ph-pencil" /></button>
      <button className="btn icon sm" onClick={s.del} title="Delete theme" aria-label="Delete theme"><I n="ph-trash" /></button>
      <span className="ts-spacer" />
      <button className="btn sm" onClick={s.surprise} title="Generate a random harmonious theme"><I n="ph-shuffle" /> Surprise me</button>
    </div>
  );
}
