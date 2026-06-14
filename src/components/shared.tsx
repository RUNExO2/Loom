import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toastVariants } from "../lib/motionVariants";
import { TYPE_ICON, TYPE_COLOR, TYPE_LABEL } from "../lib/typeMeta";
import { I, cx, useLoom, clickable } from "../lib/context";
import { useItemStore, Entity } from "../lib/itemStore";
import { buildAdjacency, indexById, neighborItems } from "../lib/relations";
import { useCommands, unlinkCommand } from "../lib/commands";
import { LinkPicker } from "./LinkPicker";
import { OverlayShell } from "./ui/OverlayShell";
import { SHORTCUTS } from "../lib/settings";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

// Keyboard shortcut reference — opened via `?` or the command palette.
// Reads the single canonical SHORTCUTS list plus a couple of UI-only gestures.
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const extra: { keys: string[]; label: string }[] = [
    { keys: ["?"], label: "Show this shortcuts panel" },
    { keys: ["Double-click"], label: "Edit note text in place" },
    { keys: ["Drag header"], label: "Reorder a dashboard widget" },
    { keys: ["Drag edge"], label: "Resize a dashboard widget" },
  ];
  const all = [...SHORTCUTS.map((s) => ({ keys: s.keys, label: s.label })), ...extra];
  return (
    <OverlayShell onClose={onClose} title="Keyboard shortcuts">
      <div className="shortcuts-panel">
        <div className="shortcuts-head">
          <div className="modal-ico"><I n="ph-keyboard" w="fill" /></div>
          <span className="t">Keyboard shortcuts</span>
          <button className="tb-iconbtn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close shortcuts"><I n="ph-x" /></button>
        </div>
        <div className="shortcuts-body">
          {all.map((s, i) => (
            <div className="shortcut-row" key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border-faint)" }}>
              <span className="shortcut-label">{s.label}</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="shortcut-keys">{s.keys.map((k, j) => <span className="kbd" key={j}>{k}</span>)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </OverlayShell>
  );
}

// Type→label that never crashes on unmapped runtime item_types (e.g. "library", "calendar").
const tlabel = (t: string) => TYPE_LABEL[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : "Item");

interface EntityChipProps { id: string; sub?: boolean; }
export function EntityChip({ id, sub }: EntityChipProps) {
  const { inspect } = useLoom();
  const { resolve } = useItemStore();
  const e = resolve(id);
  if (!e) return null;
  return (
    <button className="chip" style={{ "--mod": e.color } as any} onClick={() => inspect(id)} title={`Open ${e.title}`}>
      <I n={e.icon} />
      <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</span>
      {sub && <span className="ghost mono-sm" style={{ fontSize: "var(--fs-3xs)" }}>{TYPE_LABEL[e.type] || e.type}</span>}
    </button>
  );
}

interface InlineLinkProps { id: string; }
export function InlineLink({ id }: InlineLinkProps) {
  const { inspect } = useLoom();
  const { resolve } = useItemStore();
  const e = resolve(id);
  if (!e) return <span>?</span>;
  return (
    <span className="inline-link" onClick={() => inspect(id)}>
      <I n={e.icon} /> {e.title}
    </span>
  );
}

interface ConnectionsPanelProps { id: string; onClose: () => void; }
export function ConnectionsPanel({ id, onClose }: ConnectionsPanelProps) {
  const { inspect, navigate, toast } = useLoom();
  const { resolve, items, links: allLinks, link, unlink, create } = useItemStore();
  const commands = useCommands();
  const [picking, setPicking] = useState(false);
  const e = resolve(id);

  // An in-app bookmark already pointing at this entity (so the button can toggle off).
  const existingBookmark = items.find((it) => {
    if (it.item_type !== "bookmark") return false;
    try { return JSON.parse(it.metadata || "{}").targetId === id; } catch { return false; }
  });

  const bookmarkThis = async () => {
    if (!e) return;
    try {
      await create("bookmark", e.title, {
        url: "", createdAt: new Date().toISOString(), tags: [],
        targetId: id, targetType: e.type,
      });
      toast("Bookmarked — find it in Bookmarks", "ph-bookmark-simple");
    } catch (err) { console.error("Failed to bookmark item:", err); }
  };

  // Relationships are DERIVED from the SQLite links table held in the store — reactive
  // to link/unlink commands, orphan-free (only neighbours that still exist as items).
  const linked = neighborItems(buildAdjacency(allLinks), indexById(items), id)
    .map((it) => resolve(it.id))
    .filter(Boolean) as Entity[];

  const doUnlink = (targetId: string, title: string) =>
    commands.run(unlinkCommand(link, unlink, resolve, id, targetId, `Unlink ${title}`));

  if (!e) return null;
  const color = e.color;
  const groups: Record<string, any[]> = {};
  linked.forEach((l: any) => { (groups[l.type] = groups[l.type] || []).push(l); });
  const order = ["project", "note", "task", "file", "bookmark", "media", "habit", "timeline", "automation", "vault"];
  const sortedTypes = Object.keys(groups).sort((a, b) => order.indexOf(a) - order.indexOf(b));

  const VIEW: Record<string, string> = {
    note: "notes", task: "tasks", project: "projects", library: "library", media: "library",
    file: "files", bookmark: "bookmarks", habit: "habits", calendar: "calendar",
    vault: "vault", automation: "automation", timeline: "timeline",
  };
  const navTo = VIEW[e.type] || "dashboard";

  return (
    <aside className="conn-panel" style={{ "--mod": color } as any}>
      <div className="conn-head">
        <div className="ico"><I n={e.icon || TYPE_ICON[e.type]} w="fill" /></div>
        <div className="meta">
          <div className="k">{tlabel(e.type)} · Connections</div>
          <div className="t">{e.title}</div>
        </div>
        <button className="tb-iconbtn" onClick={onClose} title="Close" aria-label="Close connections panel"><I n="ph-x" /></button>
      </div>
      <div className="conn-scroll">
        <div className="conn-sec-t" style={{ marginTop: 0 }}>
          Relationship map <span className="ct">{linked.length} linked</span>
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setPicking(true)}>
            <I n="ph-link" /> Add link
          </button>
        </div>
        <RelGraph center={e} links={linked} onPick={inspect} />

        {e.desc && <p className="muted" style={{ fontSize: "var(--fs-sm)", lineHeight: 1.6, margin: "14px 0 4px" }}>{e.desc}</p>}

        {sortedTypes.length === 0 && (
          <div className="muted" style={{ fontSize: "var(--fs-sm)", padding: "20px 0", textAlign: "center" }}>
            <I n="ph-link-break" style={{ fontSize: "var(--fs-3xl)", display: "block" as any, marginBottom: 8, opacity: 0.5 }} />
            No links yet. Use “Add link” to connect this to anything.
          </div>
        )}

        {sortedTypes.map((t) => (
          <div key={t}>
            <div className="conn-sec-t" style={{ "--mod": TYPE_COLOR[t] } as any}>
              <I n={TYPE_ICON[t]} style={{ fontSize: "var(--fs-md)", color: TYPE_COLOR[t] }} />
              {tlabel(t)}s <span className="ct">{groups[t].length}</span>
            </div>
            {groups[t].map((l: any) => (
              <div key={l.id} className="conn-link" style={{ "--mod": TYPE_COLOR[l.type] } as any} onClick={() => inspect(l.id)} {...clickable(() => inspect(l.id))}>
                <I n={l.icon || TYPE_ICON[l.type]} />
                <span className="cl-t">{l.title}</span>
                <button className="cl-unlink" title="Unlink" aria-label={`Unlink ${l.title}`}
                  onClick={(ev) => { ev.stopPropagation(); doUnlink(l.id, l.title); }}>
                  <I n="ph-link-break" />
                </button>
                <span className="cl-m"><I n="ph-arrow-up-right" /></span>
              </div>
            ))}
          </div>
        ))}

        <div className="divider"></div>
        <div className="col gap6">
          <button className="btn sm" style={{ width: "100%", justifyContent: "center" }} onClick={() => {
            try {
              new WebviewWindow(`item-popout-${id.slice(0, 8)}`, {
                url: `/?view=${navTo}&focus=${id}`,
                title: e.title, width: 980, height: 720, center: true, resizable: true, decorations: true,
              });
            } catch (err) { console.error("Pop-out failed:", err); toast("Could not open pop-out window", "ph-warning"); }
          }}>
            <I n="ph-app-window" /> Pop-out New Window
          </button>
          <button className="btn sm" style={{ width: "100%", justifyContent: "center" }} onClick={() => navigate(navTo)}>
            <I n="ph-arrow-square-out" /> Open in {tlabel(e.type)}
          </button>
          {e.type !== "bookmark" && (
            existingBookmark ? (
              <button className="btn sm active" style={{ width: "100%", justifyContent: "center" }} onClick={() => { navigate("bookmarks"); }}>
                <I n="ph-bookmark-simple" w="fill" /> Bookmarked — view in Bookmarks
              </button>
            ) : (
              <button className="btn sm" style={{ width: "100%", justifyContent: "center" }} onClick={bookmarkThis}>
                <I n="ph-bookmark-simple" /> Bookmark this {tlabel(e.type)}
              </button>
            )
          )}
        </div>
      </div>
      <AnimatePresence>
        {picking && <LinkPicker key="link-picker" sourceId={id} onClose={() => setPicking(false)} />}
      </AnimatePresence>
    </aside>
  );
}

function RelGraph({ center, links, onPick }: { center: any; links: any[]; onPick: (id: string) => void }) {
  const shown = links.slice(0, 8);
  const cx0 = 144, cy0 = 75, R = 56;
  const pts = shown.map((l: any, i: number) => {
    const ang = (-Math.PI / 2) + (i / Math.max(shown.length, 1)) * Math.PI * 2;
    return { l, x: cx0 + Math.cos(ang) * R, y: cy0 + Math.sin(ang) * R };
  });
  const ccolor = TYPE_COLOR[center.type] || "var(--accent)";
  return (
    <div className="conn-graph">
      <svg width="100%" height="150" viewBox="0 0 288 150" style={{ display: "block" }}>
        {pts.map((p, i) => (
          <line key={i} x1={cx0} y1={cy0} x2={p.x} y2={p.y} stroke="var(--border-strong)" strokeWidth="1" />
        ))}
        {pts.map((p, i) => (
          <g key={i} style={{ cursor: "pointer" }} onClick={() => onPick(p.l.id)}>
            <circle cx={p.x} cy={p.y} r="11" fill="var(--surface-3)" stroke={TYPE_COLOR[p.l.type]} strokeWidth="1.5" />
            <text x={p.x} y={p.y + 1} textAnchor="middle" dominantBaseline="middle" fontSize="10" fill={TYPE_COLOR[p.l.type]} fontFamily="SF Mono, monospace">
              {tlabel(p.l.type)[0]}
            </text>
          </g>
        ))}
        <circle cx={cx0} cy={cy0} r="17" fill={ccolor} opacity="0.18" />
        <circle cx={cx0} cy={cy0} r="13" fill="var(--bg)" stroke={ccolor} strokeWidth="2" />
        <text x={cx0} y={cy0 + 1} textAnchor="middle" dominantBaseline="middle" fontSize="11" fill={ccolor} fontFamily="SF Mono, monospace" fontWeight="600">
          {tlabel(center.type)[0]}
        </text>
      </svg>
    </div>
  );
}

// One empty-state language across widgets, lists, and pickers.
// `compact` is the inline/widget variant; default suits full module views.
export function EmptyState({ icon, title, sub, mod, compact, children }: {
  icon: string; title: React.ReactNode; sub?: string; mod?: string; compact?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className={compact ? "empty-state compact" : "empty-state"} style={mod ? ({ "--mod": mod } as any) : undefined}>
      <div className="es-glyph" aria-hidden><I n={icon} /></div>
      <div className="es-t">{title}</div>
      {sub && <div className="es-s">{sub}</div>}
      {children}
    </div>
  );
}

export type ToastKind = "success" | "error" | "warning" | "info";
interface ToastItem {
  id: string; msg: string; icon?: string; kind?: ToastKind; duration?: number;
  action?: { label: string; onClick: () => void };
}
interface ToastsProps { items: ToastItem[]; onDismiss?: (id: string) => void; }

const KIND_ICON: Record<ToastKind, string> = {
  success: "ph-check-circle", error: "ph-x-circle", warning: "ph-warning", info: "ph-info",
};

export function Toasts({ items, onDismiss }: ToastsProps) {
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      <AnimatePresence>
        {items.map((t) => {
          const kind = t.kind || "info";
          return (
            <motion.div
              layout
              className={cx("toast", `toast-${kind}`)}
              key={t.id}
              variants={toastVariants}
              initial="initial" animate="enter" exit="exit"
            >
              <I n={t.icon || KIND_ICON[kind]} w="fill" /> {t.msg}
              {t.action && (
                <button className="toast-action" onClick={() => { t.action!.onClick(); onDismiss?.(t.id); }}>
                  <I n="ph-arrow-counter-clockwise" /> {t.action.label}
                </button>
              )}
              <button className="toast-close" aria-label="Dismiss notification" onClick={() => onDismiss?.(t.id)}>
                <I n="ph-x" />
              </button>
              <span className="toast-progress" style={{ animationDuration: `${t.duration ?? 2800}ms` }} aria-hidden />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
