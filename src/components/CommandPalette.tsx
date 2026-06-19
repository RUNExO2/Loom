import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { NAV, TYPE_ICON, TYPE_COLOR, TYPE_LABEL } from "../lib/typeMeta";
import { I, cx, useLoom, clickable } from "../lib/context";
import { searchItems } from "../ipc/search";
import { useItemStore } from "../lib/itemStore";
import { getRecentOpened } from "../lib/viewMemory";
import { useActions } from "../lib/actions";
import { OverlayShell } from "./ui/OverlayShell";

function highlight(text: string, q: string) {
  if (!q) return <>{text}</>;
  let result = [];
  let qIndex = 0;
  for (let i = 0; i < text.length; i++) {
    if (qIndex < q.length && text[i].toLowerCase() === q[qIndex].toLowerCase()) {
      result.push(<b key={i} style={{ color: "var(--accent)" }}>{text[i]}</b>);
      qIndex++;
    } else {
      result.push(text[i]);
    }
  }
  return <>{result}</>;
}

interface CommandPaletteProps { onClose: () => void; }
export function CommandPalette({ onClose }: CommandPaletteProps) {
  const ctx = useLoom();
  const { workspaceId, items: allItems } = useItemStore();
  const { dispatch, actions } = useActions();
  // Palette-shaped command items from the single action registry — one source.
  const commandItems = useMemo(
    () => actions.map((a) => ({ id: a.id, label: a.title, kind: "command" as const, icon: a.icon, color: a.color, sub: "Command", keywords: a.keywords || "" })),
    [actions],
  );
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  useEffect(() => {
    if (!q.trim() || !workspaceId) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      searchItems(q.trim(), workspaceId).then((items) => {
        const mapped = items.map((e) => {
          let meta: any = {};
          try { meta = JSON.parse(e.metadata || "{}"); } catch (err) { /* ignore */ }
          
          let icon = TYPE_ICON[e.item_type] || "ph-file";
          let color = TYPE_COLOR[e.item_type] || "var(--text)";
          let sub = "";
          
          if (e.item_type === "task") { icon = "ph-check-square"; color = "var(--h-tasks)"; sub = meta.project || "Task"; }
          if (e.item_type === "note") { icon = "ph-note-pencil"; color = "var(--h-notes)"; sub = meta.folder || "Note"; }
          if (e.item_type === "library") { icon = meta.icon || "ph-book"; color = meta.color || "var(--h-library)"; sub = meta.kind || "Library"; }
          if (e.item_type === "calendar") { icon = "ph-calendar-dots"; color = meta.color || "var(--h-calendar)"; sub = meta.sub || "Event"; }

          return {
            id: e.id,
            label: e.title,
            kind: "entity",
            entity: { ...e, ...meta },
            icon,
            color,
            sub,
            type: e.item_type
          };
        });
        setSearchResults(mapped);
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [q, workspaceId]);

  const corpus = useMemo(() => {
    const out: any[] = [];
    // "Coming soon" modules stay out of the palette until they ship.
    NAV.forEach((g) => g.items.filter((it) => !it.soon).forEach((it) => out.push({
      id: "nav-" + it.id, label: it.label, kind: "navigate", icon: it.icon, color: it.mod, sub: "Go to " + it.label, navTo: it.id,
    })));
    return out;
  }, []);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();

    const formatEntity = (e: any) => {
      let meta: any = {};
      try { meta = JSON.parse(e.metadata || "{}"); } catch (err) { /* ignore */ }
      let icon = TYPE_ICON[e.item_type] || "ph-file";
      let color = TYPE_COLOR[e.item_type] || "var(--text)";
      let sub = "";
      if (e.item_type === "task") { icon = "ph-check-square"; color = "var(--h-tasks)"; sub = meta.project || "Task"; }
      if (e.item_type === "note") { icon = "ph-note-pencil"; color = "var(--h-notes)"; sub = meta.folder || "Note"; }
      if (e.item_type === "library") { icon = meta.icon || "ph-book"; color = meta.color || "var(--h-library)"; sub = meta.kind || "Library"; }
      if (e.item_type === "calendar") { icon = "ph-calendar-dots"; color = meta.color || "var(--h-calendar)"; sub = meta.sub || "Event"; }
      return { id: e.id, label: e.title, kind: "entity", entity: { ...e, ...meta }, icon, color, sub, type: e.item_type, _meta: meta };
    };

    if (!query) {
      const openedIds = getRecentOpened();
      const recentOpened = openedIds.map(id => allItems.find(i => i.id === id)).filter(Boolean).slice(0, 4).map(formatEntity);
      const recentCreated = [...allItems].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)).slice(0, 4).map(formatEntity);
      
      const getUpdatedTs = (item: any, meta: any) => {
        if (meta.updated) {
          const t = new Date(meta.updated).getTime();
          if (!isNaN(t)) return t;
        }
        if (meta.tracking?.lastActivityAt) {
          const t = new Date(meta.tracking.lastActivityAt).getTime();
          if (!isNaN(t)) return t;
        }
        if (meta.dueDate) {
          const t = new Date(meta.dueDate).getTime();
          if (!isNaN(t)) return t;
        }
        return Number(item.created_at || 0) * 1000;
      };
      
      const recentEdited = [...allItems].map((i: any) => {
        let meta: any = {};
        try { meta = JSON.parse(i.metadata || "{}"); } catch(e) {}
        return { item: i, ts: getUpdatedTs(i, meta) };
      }).sort((a: any, b: any) => b.ts - a.ts).slice(0, 4).map((e: any) => formatEntity(e.item));

      return {
        groups: [
          ...(recentOpened.length ? [{ title: "Recent: Opened", items: recentOpened }] : []),
          ...(recentEdited.length ? [{ title: "Recent: Edited", items: recentEdited }] : []),
          ...(recentCreated.length ? [{ title: "Recent: Created", items: recentCreated }] : []),
          { title: "Commands", items: commandItems },
        ],
      };
    }
    const score = (c: any) => {
      const l = c.label.toLowerCase();
      if (l === query) return 100;
      if (l.startsWith(query)) return 80;
      if (l.includes(query)) return 50;
      
      let fuzzyMatch = true;
      let lIndex = 0;
      for (let i = 0; i < query.length; i++) {
        let found = l.indexOf(query[i], lIndex);
        if (found === -1) { fuzzyMatch = false; break; }
        lIndex = found + 1;
      }
      if (fuzzyMatch) return 30;

      if (c.sub && c.sub.toLowerCase().includes(query)) return 20;
      return 0;
    };
    const cmds = commandItems.map((c) => ({ ...c, _s: (c.label + " " + c.keywords).toLowerCase().includes(query) ? 60 : 0 })).filter((c) => c._s > 0);
    const nav = corpus.map((c) => ({ ...c, _s: score(c) })).filter((c) => c._s > 0).sort((a, b) => b._s - a._s);
    const ents = searchResults;

    const groups: any[] = [];
    if (cmds.length) groups.push({ title: "Commands", items: cmds });
    if (nav.length) groups.push({ title: "Navigate", items: nav });
    if (ents.length) groups.push({ title: `Results · ${ents.length}`, items: ents });
    if (!groups.length) groups.push({ title: "No matches", items: [] });
    return { groups };
  }, [q, corpus, searchResults, commandItems]);

  const flat = useMemo(() => results.groups.flatMap((g) => g.items), [results]);
  // Functional updater reads the freshest sel, so the effect needs only flat.length.
  useEffect(() => { setSel((s) => (s >= flat.length ? 0 : s)); }, [flat.length]);

  const topEntity = useMemo(() => {
    const cur = flat[sel];
    if (cur && cur.kind === "entity") return cur.entity;
    const firstEnt = flat.find((f: any) => f.kind === "entity");
    return firstEnt ? firstEnt.entity : null;
  }, [flat, sel]);

  const choose = useCallback((item: any) => {
    if (!item) return;
    onClose();
    if (item.kind === "navigate") { ctx.navigate(item.navTo); return; }
    if (item.kind === "entity") { ctx.inspect(item.id); return; }
    // Every command routes through the single action dispatcher — no inline logic here.
    if (item.kind === "command") { dispatch(item.id); return; }
  }, [ctx, onClose, dispatch]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(flat[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  useEffect(() => {
    const el = listRef.current && listRef.current.querySelector(".cmd-item.sel");
    if (el) (el as Element).scrollIntoView({ block: "nearest" });
  }, [sel]);

  let idx = -1;
  return (
    <OverlayShell onClose={onClose} title="Command palette" align="top">
      <div className="cmd">
        <div className="cmd-in">
          <I n="ph-magnifying-glass" />
          <input ref={inputRef} value={q} placeholder='Search everything, run a command, or jump to…'
            onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey} />
          {q ? <span className="cmd-scope">{flat.length} results</span> : <span className="kbd">ESC</span>}
        </div>

        <div className="cmd-results" ref={listRef}>
          {results.groups.map((g, gi) => (
            <div key={gi}>
              <div className="cmd-section">{g.title}</div>
              {g.items.map((item: any) => {
                idx++; const isSel = idx === sel; const myIdx = idx;
                return (
                  <div key={item.id} className={cx("cmd-item", isSel && "sel")} style={{ "--mod": item.color } as any}
                    onMouseEnter={() => setSel(myIdx)} onClick={() => choose(item)}>
                    <div className="cmd-ico"><I n={item.icon} w={item.kind === "entity" ? "fill" : "regular"} /></div>
                    <div className="cmd-main">
                      <div className="cmd-t">
                        {highlight(item.label, q)}
                        {item.entity && item.entity.tag && <span className="tag" style={{ marginLeft: 8 }}>#{item.entity.tag}</span>}
                      </div>
                      <div className="cmd-s">{item.sub}</div>
                    </div>
                    <span className="cmd-kind">{item.kind === "entity" ? TYPE_LABEL[item.type] : item.kind}</span>
                    <span className="cmd-enter">↵</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {topEntity && (topEntity.links || []).length > 0 && (
          <ConnectedPreview entity={topEntity} onPick={(id: string) => { onClose(); ctx.inspect(id); }} />
        )}

        <div className="cmd-foot">
          <span className="fk"><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
          <span className="fk"><span className="kbd">↵</span> open</span>
          <span className="fk"><span className="kbd">⌘K</span> toggle</span>
          <span style={{ marginLeft: "auto" }} className="fk"><I n="ph-link" style={{ color: "var(--accent-text)" }} /> connected search</span>
        </div>
      </div>
    </OverlayShell>
  );
}

function ConnectedPreview({ entity, onPick }: { entity: any; onPick: (id: string) => void }) {
  const { resolve } = useItemStore();
  const links = (entity.links || []).map((id: string) => resolve(id)).filter(Boolean);
  const byType: Record<string, any[]> = {};
  links.forEach((l: any) => { (byType[l.type] = byType[l.type] || []).push(l); });
  const cells = links.slice(0, 6);
  return (
    <div className="cmd-connect" style={{ "--mod": TYPE_COLOR[entity.type] } as any}>
      <div className="cmd-connect-head">
        <I n="ph-graph" style={{ color: TYPE_COLOR[entity.type], fontSize: "var(--fs-lg)" }} />
        <span className="ttl">{entity.title}</span>
        <span className="lk">{links.length} connections · {Object.keys(byType).length} types</span>
      </div>
      <div className="cmd-connect-grid">
        {cells.map((l: any) => (
          <div key={l.id} className="cc-cell" style={{ "--mod": TYPE_COLOR[l.type] } as any} onClick={() => onPick(l.id)} {...clickable(() => onPick(l.id))}>
            <I n={l.icon || TYPE_ICON[l.type]} />
            <div style={{ minWidth: 0 }}>
              <div className="cc-n">{l.title}</div>
              <div className="cc-k">{TYPE_LABEL[l.type]}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
