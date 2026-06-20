import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as Switch from "@radix-ui/react-switch";
import { I, cx, useLoom } from "../../lib/context";
import { EntityChip, EmptyState } from "../shared";
import { Item } from "../../ipc/items";
import { useAutomations, useItemStore } from "../../lib/itemStore";
import { getAutomationMeta } from "../../lib/meta";
import {
  runAutomationNow, getAutomationExecutions, getAutomationStats,
  ExecutionRow, AutomationStats, EVENT_TYPES, ENTITY_TYPES, CMP_OPS, ACTION_TYPES,
} from "../../ipc/automation";
import { createAutomationViewModel, filterExecutions } from "../../lib/viewmodels";
import { fsWriteAnyFile } from "../../ipc/fs";
import { save } from "@tauri-apps/plugin-dialog";
import { PageHead } from "./shared";

const fld: React.CSSProperties = {
  background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)",
  color: "var(--text)", padding: "7px 10px", fontSize: "var(--fs-sm)", width: "100%",
};
const lbl: React.CSSProperties = { fontSize: "var(--fs-sm)", color: "var(--text-faint)", marginBottom: 4, display: "block" };

function StatusPill({ s }: { s: string }) {
  const map: Record<string, [string, string]> = {
    SUCCESS: ["var(--h-habits)", "ph-check-circle"],
    FAILED: ["var(--danger)", "ph-x-circle"],
    PARTIAL: ["oklch(0.75 0.15 75)", "ph-warning-circle"],
    SKIPPED: ["var(--text-faint)", "ph-minus-circle"],
    RUNNING: ["var(--h-automation)", "ph-spinner"],
  };
  const [c, i] = map[s] || ["var(--text-faint)", "ph-circle"];
  return <span className="mono-sm" style={{ color: c, display: "inline-flex", alignItems: "center", gap: 4 }}><I n={i} w="fill" /> {s}</span>;
}

function ExecutionHistory({ automationId, title, onBack }: { automationId?: string; title: string; onBack: () => void }) {
  const [rows, setRows] = useState<ExecutionRow[] | null>(null);
  const [sel, setSel] = useState<ExecutionRow | null>(null);
  const [filter, setFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    getAutomationExecutions(automationId, 200).then(setRows).catch((e) => { console.error(e); setRows([]); });
  }, [automationId]);
  useEffect(() => { load(); }, [load]);

  const statusView = filterExecutions(rows, filter);
  const q = search.trim().toLowerCase();
  const view = q
    ? statusView.filter((r) => `${r.trigger_source} ${r.error || ""} ${r.output || ""}`.toLowerCase().includes(q))
    : statusView;

  const stats = useMemo(() => {
    const r = rows || [];
    const by = (s: string) => r.filter((x) => x.status === s).length;
    const durs = r.map((x) => x.duration_ms).filter((d): d is number => d != null);
    const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
    return { total: r.length, success: by("SUCCESS"), failed: by("FAILED"), partial: by("PARTIAL"), avg };
  }, [rows]);

  const exportLog = async () => {
    const dest = await save({ title: "Export automation log", defaultPath: `automation-log.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!dest) return;
    try { await fsWriteAnyFile(dest, JSON.stringify(view, null, 2)); }
    catch (e) { console.error("Log export failed", e); }
  };

  return (
    <div className="col gap16">
      <div className="row gap8" style={{ alignItems: "center" }}>
        <button className="btn sm" onClick={onBack}><I n="ph-arrow-left" /> Back</button>
        <h2 style={{ fontSize: "var(--fs-lg)", fontWeight: 600, flex: 1 }}>History · {title}</h2>
        <input style={{ ...fld, width: 180 }} placeholder="Search log…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={{ ...fld, width: 130 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          {["ALL", "SUCCESS", "FAILED", "PARTIAL", "SKIPPED", "RUNNING"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn sm" onClick={exportLog} title="Export filtered log to JSON"><I n="ph-export" /> Export</button>
        <button className="btn sm" onClick={load}><I n="ph-arrows-clockwise" /> Refresh</button>
      </div>
      {rows && rows.length > 0 && (
        <div className="row gap8" style={{ flexWrap: "wrap" }}>
          {[
            { label: "Runs", value: stats.total, color: "var(--text-dim)" },
            { label: "Success", value: stats.success, color: "var(--sys-good, var(--accent))" },
            { label: "Failed", value: stats.failed, color: "var(--danger)" },
            { label: "Partial", value: stats.partial, color: "var(--sys-warn, var(--accent))" },
            { label: "Avg", value: stats.avg != null ? `${stats.avg}ms` : "—", color: "var(--text-dim)" },
          ].map((s) => (
            <div key={s.label} style={{ ...fld, width: "auto", padding: "6px 12px", display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ fontWeight: 700, color: s.color }}>{s.value}</span>
              <span className="mono-sm ghost">{s.label}</span>
            </div>
          ))}
        </div>
      )}
      {rows === null ? <div className="muted">Loading…</div>
        : view.length === 0 ? <EmptyState icon="ph-clock-counter-clockwise" mod="var(--h-automation)" title="No runs yet" sub="Run the automation or wait for its trigger to fire." />
        : (
          <div className="col gap6">
            {view.map((r) => (
              <div key={r.id}>
                <div className="row gap12" style={{ ...fld, cursor: "pointer", alignItems: "center" }}
                  onClick={() => setSel(sel?.id === r.id ? null : r)}>
                  <StatusPill s={r.status} />
                  <span className="mono-sm ghost" style={{ flex: 1 }}>{r.trigger_source}</span>
                  <span className="mono-sm ghost">{r.actions_executed} act</span>
                  <span className="mono-sm ghost">{r.duration_ms != null ? `${r.duration_ms}ms` : "—"}</span>
                  <span className="mono-sm ghost">{new Date(r.started_at).toLocaleString()}</span>
                  <I n={sel?.id === r.id ? "ph-caret-up" : "ph-caret-down"} />
                </div>
                {sel?.id === r.id && (
                  <div style={{ ...fld, marginTop: 4, background: "var(--surface-1)" }}>
                    {r.error && <div style={{ color: "var(--danger)", marginBottom: 8 }}><I n="ph-warning" /> {r.error}</div>}
                    <div className="mono-sm" style={{ whiteSpace: "pre-wrap", color: "var(--text-faint)" }}>
                      {(() => { try { return JSON.stringify(JSON.parse(r.output || "[]"), null, 2); } catch { return r.output || "—"; } })()}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

function AutomationBuilder({ existing, options, onCancel, onSave }:
  { existing: { item: Item; meta: any } | null; options: { id: string; title: string }[];
    onCancel: () => void; onSave: (title: string, meta: any) => Promise<void> }) {
  const m0 = existing?.meta;
  const [title, setTitle] = useState(existing?.item.title || "");
  const [desc, setDesc] = useState(m0?.desc || "");
  const [on, setOn] = useState(m0?.on ?? true);
  const [trigger, setTrigger] = useState<any>(m0?.trigger || { type: "event", event: "TaskCompleted", entityType: "" });
  const [groupOp, setGroupOp] = useState<string>(m0?.conditions?.op || "AND");
  const [conds, setConds] = useState<any[]>(m0?.conditions?.rules || []);
  const [actions, setActions] = useState<any[]>(m0?.actions || [{ type: "notify", message: "Triggered" }]);
  const [err, setErr] = useState<string | null>(null);

  const setTrig = (k: string, v: any) => setTrigger((t: any) => ({ ...t, [k]: v }));
  const setAct = (i: number, k: string, v: any) => setActions((a) => a.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const setCond = (i: number, k: string, v: any) => setConds((c) => c.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const moveAct = (i: number, d: number) => setActions((a) => {
    const j = i + d; if (j < 0 || j >= a.length) return a;
    const n = [...a]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });

  const saveRule = async () => {
    if (!title.trim()) { setErr("Name is required"); return; }
    const t: any = { type: trigger.type };
    if (trigger.type === "event") { t.event = trigger.event; if (trigger.entityType) t.entityType = trigger.entityType; }
    if (trigger.type === "interval") t.intervalSecs = Math.max(60, Math.round((Number(trigger.minutes) || 5) * 60));
    if (trigger.type === "daily") t.time = trigger.time || "08:00";
    const conditions = conds.length ? { op: groupOp, rules: conds } : null;
    const meta = { ...(m0 || {}), on, color: "var(--h-automation)", desc, runs: m0?.runs || 0, trigger: t, conditions, actions };
    try { await onSave(title.trim(), meta); } catch (e: any) { setErr(e?.message || String(e)); }
  };

  const otherAutos = options.filter((a) => a.id !== existing?.item.id);

  return (
    <div className="col gap16" style={{ maxWidth: 760 }}>
      <div className="row gap8" style={{ alignItems: "center" }}>
        <button className="btn sm" onClick={onCancel}><I n="ph-arrow-left" /> Back</button>
        <h2 style={{ fontSize: "var(--fs-lg)", fontWeight: 600, flex: 1 }}>{existing ? "Edit" : "New"} automation</h2>
        <Switch.Root className="rx-switch" checked={on} onCheckedChange={setOn} aria-label="enabled">
          <Switch.Thumb className="rx-switch-thumb" />
        </Switch.Root>
        <span className="mono-sm ghost">{on ? "enabled" : "disabled"}</span>
      </div>

      <div><label style={lbl}>Name *</label><input style={fld} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Task done → log to timeline" /></div>
      <div><label style={lbl}>Description</label><textarea style={{ ...fld, minHeight: 56 }} value={desc} onChange={(e) => setDesc(e.target.value)} /></div>

      <div style={{ ...fld, padding: 14 }}>
        <div className="row gap8" style={{ marginBottom: 10 }}><I n="ph-flag" style={{ color: "var(--h-automation)" }} /><b>When (trigger)</b></div>
        <div className="row gap6" style={{ marginBottom: 10, flexWrap: "wrap" }}>
          {["event", "interval", "daily", "manual"].map((tt) => (
            <button key={tt} className={cx("btn sm", trigger.type === tt && "primary")} onClick={() => setTrig("type", tt)}>{tt}</button>
          ))}
        </div>
        {trigger.type === "event" && (
          <div className="row gap8">
            <div style={{ flex: 1 }}><label style={lbl}>Event</label>
              <select style={fld} value={trigger.event || ""} onChange={(e) => setTrig("event", e.target.value)}>
                {EVENT_TYPES.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}><label style={lbl}>Entity type (optional)</label>
              <select style={fld} value={trigger.entityType || ""} onChange={(e) => setTrig("entityType", e.target.value)}>
                <option value="">any</option>
                {ENTITY_TYPES.map((et) => <option key={et} value={et}>{et}</option>)}
              </select>
            </div>
          </div>
        )}
        {trigger.type === "interval" && (
          <div><label style={lbl}>Every N minutes (min 1)</label>
            <input style={fld} type="number" min={1} value={trigger.minutes ?? (trigger.intervalSecs ? trigger.intervalSecs / 60 : 5)} onChange={(e) => setTrig("minutes", e.target.value)} /></div>
        )}
        {trigger.type === "daily" && (
          <div><label style={lbl}>Time (24h)</label><input style={fld} type="time" value={trigger.time || "08:00"} onChange={(e) => setTrig("time", e.target.value)} /></div>
        )}
        {trigger.type === "manual" && <div className="muted">Fires only when you press "Run now".</div>}
      </div>

      <div style={{ ...fld, padding: 14 }}>
        <div className="row gap8" style={{ marginBottom: 10 }}>
          <I n="ph-funnel" style={{ color: "var(--h-automation)" }} /><b>If (conditions)</b>
          <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>— all/any must match</span>
          <div style={{ flex: 1 }} />
          <select style={{ ...fld, width: 90 }} value={groupOp} onChange={(e) => setGroupOp(e.target.value)}>
            {["AND", "OR", "NOT"].map((o) => <option key={o}>{o}</option>)}
          </select>
        </div>
        {conds.length === 0 && <div className="muted" style={{ marginBottom: 8 }}>No conditions — runs every time the trigger fires.</div>}
        <div className="col gap6">
          {conds.map((c, i) => (
            <div className="row gap6" key={i}>
              <input style={{ ...fld, flex: 1.4 }} placeholder="field e.g. metadata.priority" value={c.field || ""} onChange={(e) => setCond(i, "field", e.target.value)} />
              <select style={{ ...fld, flex: 1 }} value={c.cmp || "eq"} onChange={(e) => setCond(i, "cmp", e.target.value)}>
                {CMP_OPS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
              <input style={{ ...fld, flex: 1 }} placeholder="value" value={c.value ?? ""} onChange={(e) => setCond(i, "value", e.target.value)} />
              <button className="btn sm" onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}><I n="ph-x" /></button>
            </div>
          ))}
        </div>
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setConds((c) => [...c, { field: "", cmp: "eq", value: "" }])}><I n="ph-plus" /> Add condition</button>
      </div>

      <div style={{ ...fld, padding: 14 }}>
        <div className="row gap8" style={{ marginBottom: 10 }}><I n="ph-lightning" style={{ color: "var(--h-automation)" }} /><b>Then (actions)</b></div>
        <div className="col gap8">
          {actions.map((a, i) => (
            <div key={i} style={{ ...fld, background: "var(--surface-1)", padding: 10 }}>
              <div className="row gap6" style={{ marginBottom: 6 }}>
                <span className="mono-sm ghost">{i + 1}</span>
                <select style={{ ...fld, flex: 1 }} value={a.type} onChange={(e) => setActions((as) => as.map((x, j) => j === i ? { type: e.target.value } : x))}>
                  {ACTION_TYPES.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
                <button className="btn sm" onClick={() => moveAct(i, -1)}><I n="ph-arrow-up" /></button>
                <button className="btn sm" onClick={() => moveAct(i, 1)}><I n="ph-arrow-down" /></button>
                <button className="btn sm" onClick={() => setActions((as) => as.filter((_, j) => j !== i))}><I n="ph-trash" /></button>
              </div>
              <ActionParams a={a} i={i} setAct={setAct} otherAutos={otherAutos} />
            </div>
          ))}
        </div>
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setActions((a) => [...a, { type: "notify", message: "" }])}><I n="ph-plus" /> Add action</button>
      </div>

      {err && <div style={{ color: "var(--danger)" }}><I n="ph-warning-circle" /> {err}</div>}
      <div className="row gap8">
        <button className="btn primary" onClick={saveRule}><I n="ph-check" /> Save automation</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ActionParams({ a, i, setAct, otherAutos }: { a: any; i: number; setAct: (i: number, k: string, v: any) => void; otherAutos: { id: string; title: string }[] }) {
  const T = (k: string, ph: string) => <input style={fld} placeholder={ph} value={a[k] ?? ""} onChange={(e) => setAct(i, k, e.target.value)} />;
  switch (a.type) {
    case "createTask": case "createNote": case "createProject":
      return <div>{T("title", "New entity title")}</div>;
    case "notify":
      return <div>{T("message", "Notification message")}</div>;
    case "delay":
      return <div><input style={fld} type="number" placeholder="ms (max 10000)" value={a.ms ?? ""} onChange={(e) => setAct(i, "ms", Number(e.target.value))} /></div>;
    case "archiveEntity": case "deleteEntity":
      return <div>{T("target", "$event.entityId or an item id")}</div>;
    case "updateMetadata":
      return <div className="col gap6">{T("target", "$event.entityId")}<textarea style={{ ...fld, minHeight: 44 }} placeholder='patch JSON e.g. {"archived":true}' value={typeof a.patch === "string" ? a.patch : JSON.stringify(a.patch ?? {})} onChange={(e) => { try { setAct(i, "patch", JSON.parse(e.target.value)); } catch { setAct(i, "patch", e.target.value); } }} /></div>;
    case "createLink": case "deleteLink":
      return <div className="row gap6">{T("source", "source id / $event.entityId")}{T("target", "target id")}{T("rel", "related")}</div>;
    case "triggerAutomation": case "enableAutomation": case "disableAutomation":
      return <select style={fld} value={a.automationId || ""} onChange={(e) => setAct(i, "automationId", e.target.value)}>
        <option value="">select automation…</option>
        {otherAutos.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
      </select>;
    case "stop":
      return <div className="muted">Halts remaining actions.</div>;
    default:
      return null;
  }
}

export function AutomationModule() {
  const { toast } = useLoom();
  const { items, create, updateMeta, updateFields, ready } = useAutomations();
  const { links, items: allItems } = useItemStore();
  const [view, setView] = useState<"list" | "builder" | "history">("list");
  const [editing, setEditing] = useState<{ item: Item; meta: any } | null>(null);
  const [histTarget, setHistTarget] = useState<{ id?: string; title: string } | null>(null);
  const [stats, setStats] = useState<AutomationStats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const automationVM = useMemo(
    () => createAutomationViewModel({ items, links, allItems, stats }),
    [items, links, allItems, stats],
  );
  const { rows: list, statCards, options } = automationVM;

  const loadStats = useCallback(() => { getAutomationStats().then(setStats).catch(console.error); }, []);
  useEffect(() => { if (ready) loadStats(); }, [ready, loadStats, items.length]);

  const toggle = async (item: Item) => {
    const meta = getAutomationMeta(item);
    try { await updateMeta(item.id, { ...meta, on: !meta.on }); toast(!meta.on ? "Automation enabled" : "Automation paused", "ph-lightning"); }
    catch (err) { console.error("toggle failed:", err); }
  };

  const runNow = async (item: Item) => {
    setBusy(item.id);
    try { await runAutomationNow(item.id); toast("Ran once — check history", "ph-play"); loadStats(); }
    catch (e: any) { toast("Run failed: " + (e?.message || e), "ph-warning"); }
    finally { setBusy(null); }
  };

  const onSave = async (title: string, meta: any) => {
    if (editing) {
      await updateMeta(editing.item.id, meta);
      if (title !== editing.item.title) await updateFields(editing.item.id, title, "automation");
      toast("Automation updated", "ph-check");
    } else {
      await create(title, meta);
      toast("Automation created", "ph-lightning");
    }
    setView("list"); setEditing(null); loadStats();
  };

  if (view === "builder") {
    return (
      <div className="content-pad fade-in" style={{ "--mod": "var(--h-automation)" } as any}>
        <AutomationBuilder existing={editing} options={options} onCancel={() => { setView("list"); setEditing(null); }} onSave={onSave} />
      </div>
    );
  }
  if (view === "history" && histTarget) {
    return (
      <div className="content-pad fade-in" style={{ "--mod": "var(--h-automation)" } as any}>
        <ExecutionHistory automationId={histTarget.id} title={histTarget.title} onBack={() => { setView("list"); setHistTarget(null); }} />
      </div>
    );
  }

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-automation)" } as any}>
      <PageHead mod="var(--h-automation)" icon="ph-lightning" kicker="Automation" title="Connect the system to itself"
        sub="Event-driven rules executed by the backend engine — real triggers, conditions, actions and run history.">
        <div className="row gap6">
          <button className="btn" onClick={() => { setHistTarget({ title: "All automations" }); setView("history"); }}><I n="ph-clock-counter-clockwise" /> History</button>
          <button className="btn primary" onClick={() => { setEditing(null); setView("builder"); }}><I n="ph-plus" w="bold" /> New rule</button>
        </div>
      </PageHead>

      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(6,1fr)", marginBottom: 22 }}>
        {statCards.map((card, i) => (
          <div className="stat" key={i} style={{ "--mod": card.color } as any}>
            <div className="row" style={{ justifyContent: "space-between" }}><div className="v">{card.value}</div><I n={card.icon} w="fill" style={{ color: card.color, fontSize: "var(--fs-xl)" }} /></div>
            <div className="l">{card.label}</div>
          </div>
        ))}
      </div>

      {!ready ? (
        <div className="muted" style={{ padding: "20px 0" }}>Loading automations...</div>
      ) : list.length === 0 ? (
        <EmptyState icon="ph-lightning" mod="var(--h-automation)" title="No automations yet" sub="Build a trigger → condition → action rule to automate a flow." />
      ) : (
        <div className="col gap16">
          {list.map(({ item, meta, linked, chain }) => (
              <div key={item.id} className="flow-card" style={{ "--mod": meta.color, opacity: meta.on ? 1 : 0.62 } as any}>
                <div className="flow-head">
                  <div className="w-ico" style={{ "--mod": meta.color, width: 30, height: 30, fontSize: "var(--fs-xl)" } as any}><I n="ph-lightning" w="fill" /></div>
                  <div style={{ flex: 1 }}>
                    <div className="row gap8">
                      <span style={{ fontWeight: 600, fontSize: "var(--fs-base)" }}>{item.title}</span>
                      {meta.on && <span className="mono-sm" style={{ color: meta.color }}>● live</span>}
                      {!meta.trigger && <span className="chip" style={{ height: 20 }}><I n="ph-warning" /> not executable</span>}
                    </div>
                    <div className="muted" style={{ fontSize: "var(--fs-sm)", marginTop: 2 }}>{meta.desc}</div>
                  </div>
                  <span className="mono-sm ghost">{meta.runs} runs</span>
                  <Switch.Root className="rx-switch" checked={meta.on} onCheckedChange={() => toggle(item)} aria-label={`${item.title} ${meta.on ? "on" : "off"}`}>
                    <Switch.Thumb className="rx-switch-thumb" />
                  </Switch.Root>
                </div>
                <div className="flow-chain">
                  {chain.map((node, i) => (
                    <React.Fragment key={i}>
                      <div className="flow-node"><I n={node.i} /><div><div className="fn-l">{node.l}</div><div className="fn-t">{node.t}</div></div></div>
                      {i < chain.length - 1 && <div className="flow-arrow"><I n="ph-arrow-right" w="bold" /></div>}
                    </React.Fragment>
                  ))}
                </div>
                {linked.length > 0 && (
                  <div className="row wrap gap6" style={{ marginTop: 12 }}>{linked.map((x) => <EntityChip key={x.id} id={x.id} />)}</div>
                )}
                <div className="row gap6" style={{ marginTop: 12 }}>
                  <button className="btn sm" disabled={busy === item.id} onClick={() => runNow(item)}>
                    <I n={busy === item.id ? "ph-spinner" : "ph-play"} /> Run now
                  </button>
                  <button className="btn sm" onClick={() => { setHistTarget({ id: item.id, title: item.title }); setView("history"); }}><I n="ph-clock-counter-clockwise" /> History</button>
                  <button className="btn sm" onClick={() => { setEditing({ item, meta }); setView("builder"); }}><I n="ph-pencil-simple" /> Edit</button>
                  {meta.lastRun && <span className="mono-sm ghost" style={{ marginLeft: "auto", alignSelf: "center" }}>last run {new Date(meta.lastRun).toLocaleString()}</span>}
                </div>
              </div>
          ))}
        </div>
      )}

      <div className="api-webhooks-section" style={{ marginTop: 40, padding: 20, background: "var(--surface-2)", borderRadius: "var(--r-md)", border: "1px solid var(--border)", opacity: 0.7 }}>
        <div className="row gap12" style={{ marginBottom: 12 }}>
          <I n="ph-plugs" style={{ fontSize: 24, color: "var(--text-faint)" }} />
          <h3 style={{ fontSize: "var(--fs-lg)", fontWeight: 600 }}>Local API & Webhooks</h3>
          <span className="chip" style={{ height: 22 }}><I n="ph-flask" /> Experimental — not yet available</span>
        </div>
        <p className="muted" style={{ marginBottom: 16 }}>A local REST/WebSocket API for external integrations is planned but not implemented yet.</p>
        <div className="row gap12">
          <button className="btn sm" disabled title="Not yet available"><I n="ph-key" /> Generate API Key</button>
          <button className="btn sm" disabled title="Not yet available"><I n="ph-globe" /> Create Webhook</button>
        </div>
      </div>
    </div>
  );
}
