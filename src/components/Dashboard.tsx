import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "framer-motion";
import { listStagger, listItem, springBase } from "../lib/motionVariants";
import { I, cx, useLoom, clickable } from "../lib/context";
import { EmptyState } from "./shared";
import { OverlayShell } from "./ui/OverlayShell";
import { useItemStore } from "../lib/itemStore";
import { getTaskMeta } from "../lib/meta";
import { createDashboardViewModel, DashboardVMCtx, useDashboardVM, greetingFor } from "../lib/viewmodels";
import { Item, DashboardWidget } from "../ipc/items";
import { getActivityFeed, ActivityEntry } from "../ipc/recovery";
import { moveElement, resizeElement, compact } from "../lib/layoutEngine";
import { convertFileSrc } from "@tauri-apps/api/core";

// ---- Widget types ----
interface WidgetShellProps {
  w: any;
  layout: DashboardWidget;
  editing: boolean;
  onHide: () => void;
  onExpand: () => void;
  onRefresh: () => void;
  onDragPointerDown: (e: React.PointerEvent) => void;
  onResizePointerDown: (direction: "w" | "h" | "both") => (e: React.PointerEvent) => void;
  isDragging: boolean;
  interacting: boolean;
  dragOffset: { dx: number; dy: number } | null;
  children: React.ReactNode;
  footer?: { label: string; onClick: () => void } | null;
  dragInitPos: { x: number; y: number } | null;
}

function WidgetShell({
  w,
  layout,
  editing,
  onHide,
  onExpand,
  onRefresh,
  onDragPointerDown,
  onResizePointerDown,
  isDragging,
  interacting,
  dragOffset,
  children,
  footer,
  dragInitPos
}: WidgetShellProps) {
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  return (
    <motion.section
      id={`widget-${layout.id}`}
      layout={!isDragging}
      transition={interacting ? { duration: 0 } : springBase}
      variants={listItem}
      className={cx("widget", editing && "editing-w", isDragging && "dragging")}
      style={{
        "--mod": w.color,
        gridColumn: `${(dragInitPos ? dragInitPos.x : layout.x) + 1} / span ${layout.w}`,
        gridRow: `${(dragInitPos ? dragInitPos.y : layout.y) + 1} / span ${layout.h}`,
        // While dragging, the widget follows the cursor 1:1 via a live transform
        // (layout animation is off, so framer-motion doesn't fight the offset).
        transform: isDragging && dragOffset ? `translate(${dragOffset.dx}px, ${dragOffset.dy}px)` : undefined,
        zIndex: isDragging ? 50 : undefined,
      } as any}
    >
      <div className="w-edit-bar">
        <span 
          className="grab" 
          title="Drag to reorder" 
          aria-hidden
          onPointerDown={onDragPointerDown}
          style={{ touchAction: "none" }}
        >
          <I n="ph-dots-six" />
        </span>
        <button className="danger" onClick={onHide} title="Hide widget" aria-label={`Hide ${w.title} widget`}><I n="ph-eye-slash" /></button>
      </div>
      <div className="w-head" onPointerDown={onDragPointerDown} style={{ touchAction: "none" }}>
        <div className="w-ico"><I n={w.icon} w="fill" /></div>
        <span className="w-title">{w.title}</span>
        {w.count != null && <span className="w-count">{w.count}</span>}
        {!editing && (
          <div className="w-head-act" style={{ position: "relative" }}>
            <button className="w-mini" title="More" aria-label={`${w.title} widget options`} aria-haspopup="menu" aria-expanded={menu}
              onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}>
              <I n="ph-dots-three" />
            </button>
            {menu && (
              <div className="w-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                <button role="menuitem" onClick={() => { setMenu(false); onRefresh(); }}><I n="ph-arrows-clockwise" /> Refresh</button>
                <button role="menuitem" onClick={() => { setMenu(false); onExpand(); }}><I n="ph-arrows-out" /> Expand</button>
                <button role="menuitem" className="danger" onClick={() => { setMenu(false); onHide(); }}><I n="ph-eye-slash" /> Remove</button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="w-body">{children}</div>
      {footer && <button className="w-foot" onClick={footer.onClick}>{footer.label} <I n="ph-arrow-right" /></button>}
      
      {/* Resize handles — live in every mode; cursor arrows appear on the borders */}
      <div className="w-resize-e" onPointerDown={onResizePointerDown("w")} aria-hidden />
      <div className="w-resize-s" onPointerDown={onResizePointerDown("h")} aria-hidden />
      <div className="w-resize-se" onPointerDown={onResizePointerDown("both")} aria-hidden>
        <div className="w-resize-grip" />
      </div>
    </motion.section>
  );
}

// ---- Widget Bodies ----
function WTasks() {
  const { inspect, toast } = useLoom();
  const { updateMeta } = useItemStore();
  const { tasks: list } = useDashboardVM();
  const parentRef = useRef<HTMLDivElement>(null);
  
  const rowVirtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 5,
  });

  const toggle = async (item: Item, e: React.MouseEvent) => {
    e.stopPropagation();
    const meta = getTaskMeta(item);
    const newDone = !meta.done;
    try {
      await updateMeta(item.id, { ...meta, done: newDone });
      if (newDone) toast("Task completed", "ph-check-circle");
    } catch (err) { console.error("Failed to toggle task:", err); }
  };
  return (
    <div ref={parentRef} style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>
      {list.length === 0
        ? <EmptyState compact icon="ph-check-square" title="No tasks due today" />
        : (
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((virtualItem) => {
              const { item, meta, di, linkCount } = list[virtualItem.index];
              return (
                <div key={item.id} className={cx("wrow", meta.done && "checked")} aria-label={item.title} style={{ "--mod": "var(--h-tasks)", position: "absolute", top: 0, left: 0, width: "100%", height: `${virtualItem.size}px`, transform: `translateY(${virtualItem.start}px)` } as any} onClick={() => inspect(item.id)} {...clickable(() => inspect(item.id))}>
                  <button className={cx("chk", meta.done && "done")} onClick={(e) => toggle(item, e)} role="checkbox" aria-checked={meta.done} aria-label={`Mark "${item.title}" ${meta.done ? "open" : "complete"}`}><I n="ph-check" w="bold" /></button>
                  <div className="wrow-main">
                    <div className="wrow-t">{item.title}</div>
                    <div className="wrow-s">{meta.project}{linkCount > 0 && <span> • {linkCount} linked</span>}</div>
                  </div>
                  {di.overdue && !meta.done && (
                    <span className="tag" style={{ background: "color-mix(in oklch, var(--sys-danger) 16%, transparent)", color: "var(--sys-danger)", borderColor: "color-mix(in oklch, var(--sys-danger) 35%, transparent)" }}>{di.label}</span>
                  )}
                  {meta.priority === "high" && !meta.done && !di.overdue && (
                    <span className="tag" style={{ background: "color-mix(in oklch, var(--sys-warning) 16%, transparent)", color: "var(--sys-warning)", borderColor: "color-mix(in oklch, var(--sys-warning) 35%, transparent)" }}>high</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}

function WProjects() {
  const { inspect } = useLoom();
  const { projects: active } = useDashboardVM();
  const parentRef = useRef<HTMLDivElement>(null);
  
  const rowVirtualizer = useVirtualizer({
    count: active.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 5,
  });

  return (
    <div ref={parentRef} style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>
      {active.length === 0
        ? <EmptyState compact icon="ph-kanban" title="No active projects" />
        : (
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((virtualItem) => {
              const { item, meta } = active[virtualItem.index];
              return (
                <div key={item.id} className="wrow" aria-label={item.title} style={{ "--mod": meta.color, position: "absolute", top: 0, left: 0, width: "100%", height: `${virtualItem.size}px`, transform: `translateY(${virtualItem.start}px)` } as any} onClick={() => inspect(item.id)} {...clickable(() => inspect(item.id))}>
                  <div className="wrow-ico"><I n={meta.icon} w="fill" /></div>
                  <div className="wrow-main">
                    <div className="wrow-t">{item.title}</div>
                    <div className="bar" style={{ marginTop: 6 }}><i style={{ width: meta.progress + "%" }}></i></div>
                  </div>
                  <span className="wrow-meta">{meta.progress}%</span>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}

function WNotes() {
  const { inspect } = useLoom();
  const { notes: visible } = useDashboardVM();
  return (
    <div>
      {visible.length === 0
        ? <EmptyState compact icon="ph-note" title="No notes yet" />
        : visible.map(({ item, meta }) => (
            <div key={item.id} className="wrow" aria-label={item.title} style={{ "--mod": "var(--h-notes)" } as any} onClick={() => inspect(item.id)} {...clickable(() => inspect(item.id))}>
              <div className="wrow-ico"><I n="ph-note" w="fill" /></div>
              <div className="wrow-main">
                <div className="wrow-t">{item.title}</div>
                <div className="wrow-s">{meta.folder}</div>
              </div>
              <span className="wrow-meta">{meta.updated}</span>
            </div>
          ))}
    </div>
  );
}

function WAgenda() {
  const { inspect } = useLoom();
  const { agenda } = useDashboardVM();
  return (
    <div>
      {agenda.length === 0
        ? <EmptyState compact icon="ph-calendar-dots" title="No events" />
        : agenda.map((a) => (
        <div key={a.id} className="agenda-item" aria-label={a.title} style={{ "--mod": a.color } as any}
          onClick={() => inspect(a.id)} {...clickable(() => inspect(a.id))}>
          <div className="agenda-time">{a.time}</div>
          <div className="agenda-bar"></div>
          <div className="agenda-main">
            <div className="agenda-t">{a.title}</div>
            <div className="agenda-s">{a.sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function WHabits() {
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  const { habits: list } = useDashboardVM();
  return (
    <div>
      {list.length === 0 ? (
        <EmptyState compact icon="ph-pulse" title="No habits yet" />
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, marginBottom: 6, paddingRight: 2 }}>
            {days.map((d, i) => <span key={i} className="ghost mono-sm" style={{ width: 15, textAlign: "center", fontSize: "var(--fs-3xs)" }}>{d}</span>)}
          </div>
          {list.map(({ item, meta }) => (
            <div key={item.id} className="habit-row" style={{ "--mod": meta.color } as any}>
              <span className="habit-name">{item.title}</span>
              <span className="mono-sm" style={{ color: "var(--mod)", fontSize: "var(--fs-2xs)" }}><I n="ph-flame" w="fill" /> {meta.streak}</span>
              <div className="habit-dots">
                {meta.week.map((on, i) => <div key={i} className={cx("hdot", on ? "on" : "miss")}></div>)}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function WReading() {
  const { inspect } = useLoom();
  const { reading } = useDashboardVM();
  return reading.length === 0 ? (
    <EmptyState compact icon="ph-book-open" title="No reading items" />
  ) : (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
      {reading.map(({ item, meta, progress }) => (
        <div key={item.id} className="media-card" aria-label={item.title} style={{ "--mod": meta.color } as any} onClick={() => inspect(item.id)} {...clickable(() => inspect(item.id))}>
          <div className="cover">
            {meta.coverPath ? <img src={convertFileSrc(meta.coverPath)} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt={item.title} /> : <><div className="ph-stripe"></div><div className="cover-ico"><I n={meta.icon} w="fill" /></div></>}
          </div>
          <div className="mc-t">{item.title}</div>
          <div className="mc-prog">
            <div className="pl"><span>{progress.label}</span><span>{meta.progress.total > 0 ? progress.perc + "%" : ""}</span></div>
            <div className="bar"><i style={{ width: progress.perc + "%" }}></i></div>
          </div>
        </div>
      ))}
    </div>
  );
}

function WWatching() {
  const { inspect } = useLoom();
  const { watching } = useDashboardVM();
  return watching.length === 0 ? (
    <EmptyState compact icon="ph-television" title="No watching items" />
  ) : (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
      {watching.map(({ item, meta, progress }) => (
        <div key={item.id} className="media-card" aria-label={item.title} style={{ "--mod": meta.color } as any} onClick={() => inspect(item.id)} {...clickable(() => inspect(item.id))}>
          <div className="cover" style={{ aspectRatio: "16/10", overflow: "hidden" }}>
            {meta.coverPath ? <img src={convertFileSrc(meta.coverPath)} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt={item.title} /> : <><div className="ph-stripe"></div><div className="cover-ico"><I n={meta.icon} w="fill" /></div></>}
            <span className="cover-tag">{meta.mediaType}</span>
          </div>
          <div className="mc-t">{item.title}</div>
          <div className="mc-s">{progress.label}</div>
        </div>
      ))}
    </div>
  );
}

function WFiles() {
  const { inspect } = useLoom();
  const { files: list } = useDashboardVM();
  return (
    <div>
      {list.length === 0
        ? <EmptyState compact icon="ph-folder" title="No files yet" />
        : list.map(({ item, meta }) => (
        <div key={item.id} className="wrow" style={{ "--mod": meta.color } as any} onClick={() => inspect(item.id)} {...clickable(() => inspect(item.id))}>
          <div className="wrow-ico"><I n={meta.icon} /></div>
          <div className="wrow-main"><div className="wrow-t">{item.title}</div><div className="wrow-s">{meta.folder}</div></div>
          <span className="wrow-meta">{meta.updated}</span>
        </div>
      ))}
    </div>
  );
}

function WCapture() {
  const { toast } = useLoom();
  const store = useItemStore();
  const [v, setV] = useState("");
  const [type, setType] = useState("note");
  const types: [string, string][] = [["note", "ph-note"], ["task", "ph-check-square"], ["bookmark", "ph-bookmark-simple"], ["event", "ph-calendar-plus"]];
  const submit = async () => {
    const title = v.trim();
    if (!title) return;
    try {
      if (type === "note") await store.create("note", title, { preview: "", folder: "Unfiled", updated: "Just now", words: 0, tag: "", body: [] });
      else if (type === "task") { const d = new Date(); const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; await store.create("task", title, { done: false, priority: "med", dueDate: iso, due: "Today", project: "Inbox", subtasks: [] }); }
      else if (type === "bookmark") await store.create("bookmark", title, { url: "https://", createdAt: new Date().toISOString(), tags: [] });
      else if (type === "event") {
        const s = new Date(); const e = new Date(s.getTime() + 3600000);
        await store.create("calendar", title, { startDate: s.toISOString(), endDate: e.toISOString(), allDay: false, description: "", location: "", tags: "", sub: "Event · 1h", color: "var(--h-calendar)" });
      }
      toast(`Captured to ${type}s`, "ph-lightning");
      setV("");
    } catch (err) { console.error("Capture failed:", err); }
  };
  return (
    <div className="capture">
      <textarea value={v} onChange={(e) => setV(e.target.value)}
        placeholder="Capture a thought, task, or link… it routes to the right module."
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }} />
      <div className="capture-foot">
        <div className="cap-type">
          {types.map(([t, ic]) => <button key={t} className={cx(type === t && "on")} onClick={() => setType(t)} title={t}><I n={ic} /></button>)}
        </div>
        <span className="ghost mono-sm" style={{ fontSize: "var(--fs-2xs)" }}>⌘↵</span>
        <button className="btn primary sm" onClick={submit}><I n="ph-arrow-up" w="bold" /> Capture</button>
      </div>
    </div>
  );
}

function WStats() {
  const { stats } = useDashboardVM();
  return (
    <div>
      <div className="stat-grid">
        {stats.cards.map((c, i) => (
          <div className="stat" key={i} style={{ "--mod": c.color } as any}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="v">{c.value}</div>
              <I n={c.icon} w="fill" style={{ color: c.color, fontSize: "var(--fs-xl)" }} />
            </div>
            <div className="l">{c.label}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>Items created · 7 days</span>
          <span className="ghost mono-sm">{stats.counts.total} total</span>
        </div>
        {stats.hasSeries ? (
          <div className="spark" style={{ "--mod": "var(--h-projects)" } as any}>
            {stats.series.map((h, i) => (
              <i key={i} className={cx(i === stats.series.length - 1 && "peak")} style={{ height: (h / stats.seriesMax * 100) + "%" }}></i>
            ))}
          </div>
        ) : (
          <div className="ghost mono-sm" style={{ padding: "8px 0" }}>Not enough activity yet.</div>
        )}
      </div>
    </div>
  );
}

function WTimeline() {
  const { inspect } = useLoom();
  const { timeline: recent } = useDashboardVM();
  return (
    <div>
      {recent.length === 0
        ? <EmptyState compact icon="ph-clock-counter-clockwise" title="No activity yet" />
        : recent.map((t) => (
        <div key={t.id} className="wrow" style={{ "--mod": t.color } as any} onClick={() => inspect(t.id)} {...clickable(() => inspect(t.id))}>
          <div className="wrow-ico"><I n={t.icon} w="fill" /></div>
          <div className="wrow-main"><div className="wrow-t">{t.title}</div><div className="wrow-s">{t.sub}</div></div>
          <span className="wrow-meta">{t.when.replace("Today · ", "")}</span>
        </div>
      ))}
    </div>
  );
}

// Unified activity feed — creations + deletions across every item type, sourced from
// the backend's get_activity_feed (items.created_at + the mutation ledger). Refreshes
// when the item store changes so a new/deleted item shows up immediately.
function WActivity() {
  const { inspect } = useLoom();
  const { workspaceId, items } = useItemStore();
  const [feed, setFeed] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    getActivityFeed(workspaceId, 40).then((f) => { if (alive) setFeed(f); }).catch(() => {});
    return () => { alive = false; };
  }, [workspaceId, items.length]);
  return (
    <div>
      {feed.length === 0
        ? <EmptyState compact icon="ph-pulse" title="No activity yet" />
        : feed.map((e) => {
          const open = () => { if (e.action === "created") inspect(e.item_id); };
          return (
            <div key={e.id} className="wrow" style={{ "--mod": e.color, opacity: e.action === "deleted" ? 0.7 : 1 } as any} onClick={open} {...clickable(open)}>
              <div className="wrow-ico"><I n={e.action === "deleted" ? "ph-trash" : e.icon} w="fill" /></div>
              <div className="wrow-main"><div className="wrow-t">{e.title}</div><div className="wrow-s">{e.action === "deleted" ? "Deleted" : "Created"} · {e.kind}</div></div>
              <span className="wrow-meta">{e.when.replace("Today · ", "")}</span>
            </div>
          );
        })}
    </div>
  );
}

function WWeather() {
  const [weather, setWeather] = useState<{ temp: number; label: string; icon: string; place: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Free IP geolocation (no key), then Open-Meteo current conditions (no key).
        const geo = await fetch("https://ipapi.co/json/").then((r) => r.json());
        const lat = geo.latitude, lon = geo.longitude;
        if (typeof lat !== "number" || typeof lon !== "number") throw new Error("no location");
        const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`).then((r) => r.json());
        const cur = w.current;
        if (!cur) throw new Error("no weather");
        const info = weatherInfo(cur.weather_code);
        if (alive) setWeather({ temp: Math.round(cur.temperature_2m), label: info.label, icon: info.icon, place: geo.city || "" });
      } catch (e) {
        if (alive) setError("Weather unavailable offline");
      }
    })();
    return () => { alive = false; };
  }, []);

  if (error) return <div className="muted mono-sm" style={{ padding: "12px 8px" }}><I n="ph-cloud-slash" /> {error}</div>;
  if (!weather) return <div className="muted mono-sm" style={{ padding: "12px 8px" }}>Fetching local weather…</div>;
  return (
    <div className="row" style={{ alignItems: "center", gap: 16, height: "100%", paddingLeft: 8 }}>
      <I n={weather.icon} w="fill" style={{ fontSize: 42, color: "var(--accent)" }} />
      <div>
        <div style={{ fontSize: "var(--fs-2xl)", fontWeight: "bold", lineHeight: 1.2 }}>{weather.temp}°C</div>
        <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>{weather.label}{weather.place ? ` · ${weather.place}` : ""}</div>
      </div>
    </div>
  );
}

function WInbox() {
  const { inbox } = useDashboardVM();
  return (
    <div>
      {inbox.length === 0 ? <EmptyState compact icon="ph-tray" title="Inbox zero" /> :
        inbox.map(i => <div key={i.id} className="wrow"><div className="wrow-ico"><I n="ph-file" /></div><span className="wrow-t">{i.title}</span></div>)
      }
    </div>
  );
}

// Real custom widget: the HTML is stored per-widget in SQLite (dashboard_widgets.config)
// and rendered in a sandboxed iframe. Editable inline; persists via saveDashboard.
function WCustom({ layout, onSaveConfig }: { layout?: DashboardWidget; onSaveConfig?: (cfg: string) => void; expanded?: boolean }) {
  const config = layout?.config || "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(config);
  useEffect(() => { setDraft(config); }, [config]);

  if (editing) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 8, padding: 8 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="<h3>My widget</h3>\n<p>Any HTML/CSS…</p>"
          spellCheck={false}
          style={{ flex: 1, resize: "none", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", color: "var(--text)", fontFamily: "var(--font-mono, monospace)", fontSize: "var(--fs-xs)", padding: 8 }}
        />
        <div className="row gap6" style={{ justifyContent: "flex-end" }}>
          <button className="btn sm" onClick={() => { setDraft(config); setEditing(false); }}>Cancel</button>
          <button className="btn sm primary" onClick={() => { onSaveConfig?.(draft); setEditing(false); }}><I n="ph-check" /> Save</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", width: "100%", position: "relative", borderRadius: 8, overflow: "hidden", background: "var(--surface-2)" }}>
      {config ? (
        <iframe title="Custom Widget" sandbox="allow-popups" srcDoc={config} style={{ width: "100%", height: "100%", border: "none", background: "#fff" }} />
      ) : (
        <button onClick={() => setEditing(true)} style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, color: "var(--text-faint)" }}>
          <I n="ph-code" style={{ fontSize: 28 }} />
          <span style={{ fontSize: "var(--fs-sm)" }}>Add custom HTML</span>
        </button>
      )}
      {onSaveConfig && (
        <button className="btn icon sm" onClick={() => setEditing(true)} title="Edit widget HTML"
          style={{ position: "absolute", top: 6, right: 6, background: "var(--surface-1)", border: "1px solid var(--border)" }}>
          <I n="ph-pencil-simple" />
        </button>
      )}
    </div>
  );
}

// WMO weather code → icon + label (Open-Meteo).
function weatherInfo(code: number): { icon: string; label: string } {
  if (code === 0) return { icon: "ph-sun", label: "Clear" };
  if (code <= 3) return { icon: "ph-cloud-sun", label: "Partly cloudy" };
  if (code <= 48) return { icon: "ph-cloud-fog", label: "Fog" };
  if (code <= 67) return { icon: "ph-cloud-rain", label: "Rain" };
  if (code <= 77) return { icon: "ph-cloud-snow", label: "Snow" };
  if (code <= 82) return { icon: "ph-cloud-rain", label: "Showers" };
  if (code <= 86) return { icon: "ph-cloud-snow", label: "Snow showers" };
  return { icon: "ph-cloud-lightning", label: "Thunderstorm" };
}

function WContext() {
  const { contextCard } = useDashboardVM();
  return (
    <div className="row" style={{ alignItems: "center", gap: 12, padding: "8px 4px" }}>
      <I n={contextCard.icon} w="fill" style={{ fontSize: 32, color: "var(--accent)" }} />
      <div>
        <b style={{ color: "var(--text)" }}>{contextCard.title}</b>
        <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>{contextCard.body}</div>
      </div>
    </div>
  );
}

// ---- Widget catalog ----
const WIDGETS: Record<string, any> = {
  tasks:    { title: "Today's Tasks", icon: "ph-check-circle", color: "var(--h-tasks)", cols: [4, 6], def: 4, body: WTasks, desc: "What's due today across every project.", to: "tasks" },
  projects: { title: "Active Projects", icon: "ph-kanban", color: "var(--h-projects)", cols: [4, 6], def: 4, body: WProjects, desc: "Progress on the projects you're driving.", to: "projects" },
  stats:    { title: "Statistics", icon: "ph-chart-line-up", color: "var(--h-timeline)", cols: [4, 6, 8], def: 8, body: WStats, desc: "Commits, streaks, focus hours at a glance." },
  notes:    { title: "Recent Notes", icon: "ph-note", color: "var(--h-notes)", cols: [4, 6], def: 4, body: WNotes, desc: "Your latest knowledge entries.", to: "notes" },
  agenda:   { title: "Calendar Agenda", icon: "ph-calendar-dots", color: "var(--h-calendar)", cols: [4, 5], def: 4, body: WAgenda, desc: "Today's schedule, time-blocked.", to: "calendar" },
  habits:   { title: "Habit Progress", icon: "ph-pulse", color: "var(--h-habits)", cols: [4, 5], def: 4, body: WHabits, desc: "Streaks and weekly consistency.", to: "habits" },
  capture:  { title: "Quick Capture", icon: "ph-lightning", color: "var(--accent)", cols: [4, 6], def: 4, body: WCapture, desc: "Drop a thought; it routes itself." },
  reading:  { title: "Current Reading", icon: "ph-book-open", color: "var(--h-library)", cols: [3, 4], def: 4, body: WReading, desc: "Books in progress.", to: "library" },
  watching: { title: "Current Watching", icon: "ph-television", color: "var(--h-library)", cols: [4, 6, 8], def: 8, body: WWatching, desc: "Anime, shows, and games in flight.", to: "library" },
  files:    { title: "Recently Opened", icon: "ph-folder-open", color: "var(--h-files)", cols: [4, 6], def: 4, body: WFiles, desc: "Files you touched recently.", to: "files" },
  timeline: { title: "Recent Activity", icon: "ph-clock-counter-clockwise", color: "var(--h-timeline)", cols: [4, 6], def: 4, body: WTimeline, desc: "The latest entries in your life-stream.", to: "timeline" },
  activity: { title: "Activity Feed", icon: "ph-pulse", color: "var(--h-timeline)", cols: [4, 6], def: 4, body: WActivity, desc: "Everything created and deleted across the workspace." },
  weather:  { title: "Local Weather", icon: "ph-cloud-sun", color: "var(--accent)", cols: [4], def: 4, body: WWeather, desc: "Current conditions at your location." },
  inbox:    { title: "Global Inbox", icon: "ph-tray", color: "var(--h-notes)", cols: [4, 6], def: 4, body: WInbox, desc: "Unprocessed items across the system." },
  custom:   { title: "Custom Widget", icon: "ph-code", color: "var(--h-timeline)", cols: [4, 6, 8, 12], def: 4, body: WCustom, desc: "Embed custom HTML/CSS snippets." },
  context:  { title: "Smart Context", icon: "ph-magic-wand", color: "var(--accent)", cols: [4, 6, 8, 12], def: 8, body: WContext, desc: "Adapts to your time of day." },
};

const DEFAULT_LAYOUT: Omit<DashboardWidget, "id" | "workspace_id">[] = [
  { widget_type: "context", x: 0, y: 0, w: 8, h: 1, hidden: false },
  { widget_type: "weather", x: 8, y: 0, w: 4, h: 1, hidden: false },
  { widget_type: "stats", x: 0, y: 1, w: 8, h: 2, hidden: false },
  { widget_type: "capture", x: 8, y: 1, w: 4, h: 2, hidden: false },
  { widget_type: "tasks", x: 0, y: 3, w: 4, h: 2, hidden: false },
  { widget_type: "projects", x: 4, y: 3, w: 4, h: 2, hidden: false },
  { widget_type: "agenda", x: 8, y: 3, w: 4, h: 2, hidden: false },
  { widget_type: "inbox", x: 0, y: 5, w: 4, h: 2, hidden: false },
  { widget_type: "notes", x: 4, y: 5, w: 4, h: 2, hidden: false },
  { widget_type: "habits", x: 8, y: 5, w: 4, h: 2, hidden: false },
];

// Build the default layout for a workspace (used by both in-dashboard Reset and the
// Settings → Reset dashboard action). Real — callers persist it via saveDashboard.
export function defaultDashboardLayout(workspaceId: string): DashboardWidget[] {
  return DEFAULT_LAYOUT.map((l, i) => ({ ...l, id: `w_${i}`, workspace_id: workspaceId })) as DashboardWidget[];
}

interface DashboardProps { editing: boolean; setEditing: (v: boolean) => void; }
export function Dashboard({ editing, setEditing }: DashboardProps) {
  const ctx = useLoom();
  const store = useItemStore();
  // Single assembled projection for the whole screen, rebuilt only when the underlying
  // SQLite rows change. Widgets read slices from this via DashboardVMCtx — none of them
  // touch raw rows or derive in render. Collapsed grid → expanded=false.
  const vm = useMemo(
    () => createDashboardViewModel({ items: store.items, links: store.links }, false),
    [store.items, store.links]
  );
  const [gallery, setGallery] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [activeLayout, setActiveLayout] = useState<DashboardWidget[] | null>(null);

  useEffect(() => {
    if (store.ready) {
      if (store.dashboardWidgets.length === 0 && store.workspaceId) {
        const init = defaultDashboardLayout(store.workspaceId);
        store.saveDashboard(init);
        setActiveLayout(init);
      } else {
        setActiveLayout(compact(store.dashboardWidgets));
      }
    }
  }, [store.dashboardWidgets, store.ready, store.workspaceId]);

  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [resizingId, setResizingId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const resizeRef = useRef<{
    id: string;
    direction: "w" | "h" | "both";
    initW: number;
    initH: number;
    startX: number;
    startY: number;
    lastW: number;
    lastH: number;
    initialLayout: DashboardWidget[];
  } | null>(null);
  const dragInfoRef = useRef<{
    id: string;
    grabX: number;
    grabY: number;
    startX: number;
    startY: number;
    initX: number;
    initY: number;
    lastX: number;
    lastY: number;
    active: boolean;
    initialLayout: DashboardWidget[];
  } | null>(null);
  const latestLayoutRef = useRef<DashboardWidget[] | null>(null);

  useEffect(() => {
    latestLayoutRef.current = activeLayout;
  }, [activeLayout]);

  const handleResizePointerMove = useCallback((e: PointerEvent) => {
    if (!resizeRef.current) return;
    const ref = resizeRef.current;

    const gridEl = document.querySelector(".dash-grid");
    if (!gridEl) return;
    const rect = gridEl.getBoundingClientRect();
    const gap = 16;
    const cellW = (rect.width + gap) / 12;
    const cellH = 116;

    const deltaX = e.clientX - ref.startX;
    const deltaY = e.clientY - ref.startY;

    let newW = ref.initW;
    let newH = ref.initH;

    if (ref.direction === "w" || ref.direction === "both") {
      newW = ref.initW + Math.round(deltaX / cellW);
    }
    if (ref.direction === "h" || ref.direction === "both") {
      newH = ref.initH + Math.round(deltaY / cellH);
    }

    if (newW !== ref.lastW || newH !== ref.lastH) {
      ref.lastW = newW;
      ref.lastH = newH;

      const currentLayout = ref.initialLayout;
      if (!currentLayout) return;
      const next = resizeElement(currentLayout, ref.id, newW, newH);
      setActiveLayout(next);
    }
  }, []);

  const handleResizePointerUp = useCallback(() => {
    window.removeEventListener("pointermove", handleResizePointerMove);
    window.removeEventListener("pointerup", handleResizePointerUp);

    if (resizeRef.current) {
      if (latestLayoutRef.current) {
        store.saveDashboard(latestLayoutRef.current);
      }
      resizeRef.current = null;
      setResizingId(null);
    }
  }, [handleResizePointerMove, store]);

  const onResizePointerDown = useCallback((id: string) => (direction: "w" | "h" | "both") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;

    const widget = activeLayout?.find(w => w.id === id);
    if (!widget) return;

    resizeRef.current = {
      id,
      direction,
      initW: widget.w,
      initH: widget.h,
      startX: e.clientX,
      startY: e.clientY,
      lastW: widget.w,
      lastH: widget.h,
      initialLayout: activeLayout!
    };
    setResizingId(id);

    window.addEventListener("pointermove", handleResizePointerMove);
    window.addEventListener("pointerup", handleResizePointerUp);
  }, [activeLayout, handleResizePointerMove, handleResizePointerUp]);

  const handleDragPointerMove = useCallback((e: PointerEvent) => {
    if (!dragInfoRef.current) return;
    const ref = dragInfoRef.current;

    const dx = e.clientX - ref.startX;
    const dy = e.clientY - ref.startY;

    // Movement threshold — a plain click on the header never starts a drag.
    if (!ref.active) {
      const dist = Math.hypot(dx, dy);
      if (dist < 5) return;
      ref.active = true;
      
      const snapDx = Math.round(dx / 20) * 20;
      const snapDy = Math.round(dy / 20) * 20;

      setDraggedId(ref.id);
      setDragOffset({ dx: snapDx, dy: snapDy });
    }

    // Live pixel offset — snap the dragged widget visually to a 20px grid.
    const snapDx = Math.round(dx / 20) * 20;
    const snapDy = Math.round(dy / 20) * 20;

    // Update DOM directly for visual performance
    const widgetEl = document.getElementById(`widget-${ref.id}`);
    if (widgetEl) {
      widgetEl.style.transform = `translate(${snapDx}px, ${snapDy}px)`;
      widgetEl.style.zIndex = "50";
    }

    const gridEl = document.querySelector(".dash-grid");
    if (!gridEl) return;
    const rect = gridEl.getBoundingClientRect();
    const gap = 16;
    const cellW = (rect.width + gap) / 12;
    const cellH = 116;

    const x = Math.round((e.clientX - rect.left - ref.grabX) / cellW);
    const y = Math.round((e.clientY - rect.top - ref.grabY) / cellH);

    if (x !== ref.lastX || y !== ref.lastY) {
      ref.lastX = x;
      ref.lastY = y;

      const currentLayout = ref.initialLayout;
      if (!currentLayout) return;
      const next = moveElement(currentLayout, ref.id, x, y);
      setActiveLayout(next);
      setDragOffset({ dx: snapDx, dy: snapDy });
    }
  }, []);

  const handleDragPointerUp = useCallback(() => {
    window.removeEventListener("pointermove", handleDragPointerMove);
    window.removeEventListener("pointerup", handleDragPointerUp);
    (window as any).__loomInternalDrag = false;

    if (dragInfoRef.current) {
      const widgetEl = document.getElementById(`widget-${dragInfoRef.current.id}`);
      if (widgetEl) {
        widgetEl.style.transform = "";
        widgetEl.style.zIndex = "";
      }

      // Persist only when an actual move happened — a plain header click is a no-op.
      if (dragInfoRef.current.active && latestLayoutRef.current) {
        store.saveDashboard(latestLayoutRef.current);
      }
      dragInfoRef.current = null;
      setDraggedId(null);
      setDragOffset({ dx: 0, dy: 0 });
    }
  }, [handleDragPointerMove, store]);

  const onDragPointerDown = useCallback((id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;
    // Buttons inside the header (menu, hide) keep their own click behaviour.
    if (target.closest("button")) return;
    // Drag starts from the grab handle (edit mode) or the widget header (any mode).
    if (!target.closest(".grab") && !target.closest(".w-head")) return;

    e.stopPropagation();
    e.preventDefault();

    const widget = activeLayout?.find(w => w.id === id);
    if (!widget) return;

    const widgetEl = target.closest(".widget");
    if (!widgetEl) return;

    const rect = widgetEl.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;

    dragInfoRef.current = {
      id,
      grabX,
      grabY,
      startX: e.clientX,
      startY: e.clientY,
      initX: widget.x,
      initY: widget.y,
      lastX: widget.x,
      lastY: widget.y,
      active: false,
      initialLayout: activeLayout!
    };

    (window as any).__loomInternalDrag = true;

    window.addEventListener("pointermove", handleDragPointerMove);
    window.addEventListener("pointerup", handleDragPointerUp);
  }, [activeLayout, handleDragPointerMove, handleDragPointerUp]);

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", handleDragPointerMove);
      window.removeEventListener("pointerup", handleDragPointerUp);
      window.removeEventListener("pointermove", handleResizePointerMove);
      window.removeEventListener("pointerup", handleResizePointerUp);
    };
  }, [handleDragPointerMove, handleDragPointerUp, handleResizePointerMove, handleResizePointerUp]);

  if (!activeLayout) {
    return (
      <div className="content-pad">
        <div className="page-head">
          <div className="ph-meta">
            <div className="skeleton" style={{ width: 120, height: 14, marginBottom: 10 }} />
            <div className="skeleton" style={{ width: 280, height: 30 }} />
          </div>
        </div>
      </div>
    );
  }

  const present = new Set(activeLayout.map((l) => l.widget_type));

  const hide = (id: string) => {
    const next = activeLayout.filter((l) => l.id !== id);
    setActiveLayout(next);
    store.saveDashboard(next);
  };

  const saveWidgetConfig = (id: string, config: string) => {
    const next = activeLayout.map((l) => (l.id === id ? { ...l, config } : l));
    setActiveLayout(next);
    store.saveDashboard(next);
  };

  const add = (type: string) => {
    const w = WIDGETS[type];
    const newWidget: DashboardWidget = {
      id: crypto.randomUUID(),
      workspace_id: store.workspaceId!,
      widget_type: type,
      x: 0, y: 99, w: w.def, h: 2, hidden: false
    };
    const next = compact([...activeLayout, newWidget]);
    setActiveLayout(next);
    store.saveDashboard(next);
  };

  const reset = () => {
    const init = defaultDashboardLayout(store.workspaceId!);
    setActiveLayout(init);
    store.saveDashboard(init);
  };

  const greeting = greetingFor(new Date());

  return (
    <div className="content-pad fade-in">
      <div className="page-head">
        <div className="ph-meta">
          <div className="page-kicker" style={{ "--mod": "var(--h-dashboard)" } as any}><I n="ph-squares-four" w="fill" /> Dashboard</div>
          <h1 className="page-title">{greeting}.</h1>
          <p className="page-sub">Personal Workspace · {activeLayout.length} widgets active</p>
        </div>
        <div className="page-actions">
          {editing ? (
            <>
              <button className="btn" onClick={reset}><I n="ph-arrow-counter-clockwise" /> Reset</button>
              <button className="btn" onClick={() => setGallery(true)}><I n="ph-plus" w="bold" /> Add widget</button>
              <button className="btn primary" onClick={() => setEditing(false)}><I n="ph-check" w="bold" /> Done</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => ctx.openPalette()}><I n="ph-magnifying-glass" /> Search <span className="kbd" style={{ marginLeft: 2 }}>⌘K</span></button>
              <button className="btn" onClick={() => setEditing(true)}><I n="ph-sliders-horizontal" /> Customize</button>
            </>
          )}
        </div>
      </div>

      {editing && (
        <div className="vault-banner" style={{ "--h-vault": "var(--accent)", marginBottom: 18 } as any}>
          <I n="ph-sliders-horizontal" style={{ color: "var(--accent-text)" }} />
          <div style={{ flex: 1 }}><b>Edit mode.</b> <span className="muted">Drag a widget by its header to reorder · pull any edge or corner to resize · hide what you don't need · add more from the gallery.</span></div>
        </div>
      )}

      <DashboardVMCtx.Provider value={vm}>
      <motion.div
        className="dash-grid"
        style={{ gridAutoRows: "100px" }}
        variants={listStagger}
        initial="initial"
        animate="enter"
      >
        {activeLayout.map((l) => {
          const w = WIDGETS[l.widget_type]; 
          if (!w) return null;
          const Body = w.body;
          const meta = { ...w, count: w.count ? w.count() : null };
          
          return (
            <WidgetShell 
              key={l.id} 
              w={meta} 
              layout={l}
              editing={editing}
              onHide={() => hide(l.id)}
              onExpand={() => setExpanded(l.widget_type)}
              onRefresh={() => { store.refresh().then(() => ctx.toast("Widget refreshed", "ph-arrows-clockwise")); }}
              onDragPointerDown={onDragPointerDown(l.id)}
              onResizePointerDown={onResizePointerDown(l.id)}
              isDragging={draggedId === l.id}
              interacting={draggedId === l.id || resizingId === l.id}
              dragOffset={draggedId === l.id ? dragOffset : null}
              dragInitPos={draggedId === l.id && dragInfoRef.current ? { x: dragInfoRef.current.initX, y: dragInfoRef.current.initY } : null}
              footer={!editing && w.to ? { label: "Open " + w.title, onClick: () => ctx.navigate(w.to) } : null}
            >
              <Body layout={l} onSaveConfig={(cfg: string) => saveWidgetConfig(l.id, cfg)} />
            </WidgetShell>
          );
        })}
      </motion.div>
      </DashboardVMCtx.Provider>

      <AnimatePresence>
        {gallery && <WidgetGallery key="gallery" present={present} onAdd={add} onClose={() => setGallery(false)} />}
        {expanded && WIDGETS[expanded] && <WidgetExpand key="expand" id={expanded} onClose={() => setExpanded(null)} />}
      </AnimatePresence>
    </div>
  );
}

// Full-screen view of a single widget — the "Expand" action from the widget More menu.
// Radix (via OverlayShell) supplies Escape, backdrop dismissal, and the focus trap.
function WidgetExpand({ id, onClose }: { id: string; onClose: () => void }) {
  const { items, links } = useItemStore();
  // Expanded modal shows full collections → expanded=true. Same VM type, different size.
  const vm = useMemo(() => createDashboardViewModel({ items, links }, true), [items, links]);
  const w = WIDGETS[id];
  const Body = w.body;
  return (
    <OverlayShell onClose={onClose} title={`${w.title} expanded`}>
      <DashboardVMCtx.Provider value={vm}>
        <div className="widget-expand" style={{ "--mod": w.color } as any}>
          <div className="w-head">
            <div className="w-ico"><I n={w.icon} w="fill" /></div>
            <span className="w-title">{w.title}</span>
            <button className="tb-iconbtn" style={{ marginLeft: "auto" }} onClick={onClose} title="Close" aria-label="Close expanded widget"><I n="ph-x" /></button>
          </div>
          <div className="w-body" style={{ overflow: "auto" }}><Body /></div>
        </div>
      </DashboardVMCtx.Provider>
    </OverlayShell>
  );
}

function WidgetGallery({ present, onAdd, onClose }: { present: Set<string>; onAdd: (id: string) => void; onClose: () => void }) {
  return (
    <OverlayShell onClose={onClose} title="Add a widget">
      <div className="gallery">
        <div className="gallery-head">
          <I n="ph-squares-four" style={{ fontSize: "var(--fs-2xl)", color: "var(--accent-text)" }} />
          <span className="t">Add a widget</span>
          <button className="tb-iconbtn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close widget gallery"><I n="ph-x" /></button>
        </div>
        <div className="gallery-body">
          {Object.entries(WIDGETS).map(([id, w]: [string, any]) => {
            const added = present.has(id);
            return (
              <button key={id} className={cx("gallery-card", added && "added")} style={{ "--mod": w.color } as any} onClick={() => { if (!added) onAdd(id); }}>
                <div className="gc-h">
                  <div className="gc-ico"><I n={w.icon} w="fill" /></div>
                  <span className="gc-t">{w.title}</span>
                  {added && <span className="mono-sm ghost" style={{ marginLeft: "auto" }}>added</span>}
                </div>
                <div className="gc-d">{w.desc}</div>
              </button>
            );
          })}
        </div>
      </div>
    </OverlayShell>
  );
}
