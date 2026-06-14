import { useEffect, useMemo, useRef, useState } from "react";
import { I, cx } from "../lib/context";
import { EmptyState } from "./shared";
import { OverlayShell } from "./ui/OverlayShell";
import { useItemStore } from "../lib/itemStore";
import { useCommands, linkCommand } from "../lib/commands";
import { buildAdjacency, neighborIds } from "../lib/relations";
import { TYPE_LABEL, TYPE_COLOR } from "../lib/typeMeta";

// Command-driven link picker. Lists every item except the source and those already
// linked; choosing one RUNS a reversible link command (so it lands on the undo stack
// and writes a real row to the SQLite links table). No local relationship state.
export function LinkPicker({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const { items, links, link, unlink, resolve } = useItemStore();
  const commands = useCommands();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const source = resolve(sourceId);

  // Escape/backdrop dismissal + focus trap come from OverlayShell (Radix).
  useEffect(() => { inputRef.current?.focus(); }, []);

  const candidates = useMemo(() => {
    const adj = buildAdjacency(links);
    const linked = new Set(neighborIds(adj, sourceId));
    const needle = q.trim().toLowerCase();
    return items
      .filter((it) => it.id !== sourceId && !linked.has(it.id))
      .filter((it) => !needle || it.title.toLowerCase().includes(needle) || it.item_type.includes(needle))
      .slice(0, 50);
  }, [items, links, sourceId, q]);

  const pick = async (targetId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const target = resolve(targetId);
      await commands.run(linkCommand(link, unlink, resolve, sourceId, targetId, `Link ${target?.title ?? "item"}`));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayShell onClose={onClose} title={`Link to ${source?.title ?? "item"}`} align="top">
      <div className="link-picker">
        <div className="lp-head">
          <I n="ph-link" style={{ color: "var(--accent-text)", fontSize: "var(--fs-xl)" }} />
          <span className="lp-t">Link to {source?.title ?? "item"}</span>
          <button className="tb-iconbtn" style={{ marginLeft: "auto" }} onClick={onClose} title="Close" aria-label="Close link picker"><I n="ph-x" /></button>
        </div>
        <div className="lp-search">
          <I n="ph-magnifying-glass" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items to link…" />
        </div>
        <div className="lp-list">
          {candidates.length === 0 ? (
            <EmptyState compact icon="ph-link" title={q ? "No matching items" : "Everything is already linked"} />
          ) : candidates.map((it) => {
            const e = resolve(it.id);
            return (
              <button key={it.id} className={cx("lp-row", busy && "disabled")} style={{ "--mod": TYPE_COLOR[it.item_type] || "var(--accent)" } as any}
                onClick={() => pick(it.id)} disabled={busy}>
                <I n={e?.icon || "ph-file"} />
                <span className="lp-row-t">{it.title}</span>
                <span className="lp-row-k">{TYPE_LABEL[it.item_type] || it.item_type}</span>
                <I n="ph-plus" w="bold" />
              </button>
            );
          })}
        </div>
      </div>
    </OverlayShell>
  );
}
