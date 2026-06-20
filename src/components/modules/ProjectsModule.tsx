import React, { useMemo } from "react";
import { motion } from "framer-motion";
import { listStagger, listItem } from "../../lib/motionVariants";
import { I, cx, useLoom, clickable } from "../../lib/context";
import { Item } from "../../ipc/items";
import { useProjects, useItemStore } from "../../lib/itemStore";
import { getProjectMeta } from "../../lib/meta";
import { createProjectsViewModel } from "../../lib/viewmodels";
import { deleteCommand, useCommands } from "../../lib/commands";
import { useModal } from "../Modal";
import { EmptyState } from "../shared";
import { useViewMemory } from "../../lib/viewMemory";
import { PageHead } from "./shared";

export function ProjectsModule() {
  const { inspect, toast } = useLoom();
  const modal = useModal();
  const commands = useCommands();
  const { items, create, updateMeta, updateFields, remove, restore, ready } = useProjects();
  const { links, items: allItems } = useItemStore();
  const STATUS: Record<string, string> = { Active: "var(--sys-success)", Paused: "var(--sys-warning)", Maintained: "var(--sys-info)" };
  const { rows: list, activeCount } = useMemo(
    () => createProjectsViewModel({ projects: items, links, allItems }), [items, links, allItems],
  );
  const [viewMode, setViewMode] = useViewMemory("projects.viewMode", "list");
  const [ganttZoom, setGanttZoom] = useViewMemory("projects.ganttZoom", 1);
  const zoomGantt = (delta: number) => setGanttZoom((z: number) => Math.min(4, Math.max(1, Math.round((z + delta) * 10) / 10)));

  const addMilestone = async (item: Item) => {
    const r = await modal.form({ panel: true,
      title: "Add milestone", icon: "ph-flag-banner", accent: "var(--h-projects)", submitLabel: "Add",
      fields: [{ name: "text", label: "Milestone", placeholder: "e.g. Ship v1 beta", required: true }],
    });
    if (!r) return;
    const meta = getProjectMeta(item);
    const milestones = [...(meta.milestones || []), { id: crypto.randomUUID(), text: r.text, done: false }];
    try { await updateMeta(item.id, { ...meta, milestones }); } catch (err) { console.error(err); }
  };
  const toggleMilestone = async (item: Item, mid: string) => {
    const meta = getProjectMeta(item);
    const milestones = (meta.milestones || []).map((m) => m.id === mid ? { ...m, done: !m.done } : m);
    try { await updateMeta(item.id, { ...meta, milestones }); } catch (err) { console.error(err); }
  };
  const removeMilestone = async (item: Item, mid: string) => {
    const meta = getProjectMeta(item);
    const milestones = (meta.milestones || []).filter((m) => m.id !== mid);
    try { await updateMeta(item.id, { ...meta, milestones }); } catch (err) { console.error(err); }
  };
  const HEALTH_COLOR: Record<string, string> = { "On track": "var(--sys-success)", "At risk": "var(--sys-danger)", "Done": "var(--sys-info)" };

  const handleNew = async () => {
    const r = await modal.form({ panel: true,
      title: "New project", icon: "ph-kanban", accent: "var(--h-projects)", submitLabel: "Create project",
      fields: [
        { name: "title", label: "Name", placeholder: "Project name…", required: true },
        { name: "subtitle", label: "Subtitle", placeholder: "Optional one-liner" },
        { name: "template", label: "Template", type: "select", defaultValue: "none", options: [
          { value: "none", label: "Blank" }, { value: "software", label: "Software Project" },
          { value: "marketing", label: "Marketing Campaign" }, { value: "research", label: "Research Paper" }
        ] },
      ],
    });
    if (!r) return;

    let milestones: {id: string, text: string, done: boolean}[] = [];
    if (r.template === "software") {
      milestones = [
        { id: crypto.randomUUID(), text: "Design Specs", done: false },
        { id: crypto.randomUUID(), text: "MVP Release", done: false },
        { id: crypto.randomUUID(), text: "V1 Launch", done: false }
      ];
    } else if (r.template === "marketing") {
      milestones = [
        { id: crypto.randomUUID(), text: "Market Research", done: false },
        { id: crypto.randomUUID(), text: "Asset Creation", done: false },
        { id: crypto.randomUUID(), text: "Campaign Launch", done: false }
      ];
    } else if (r.template === "research") {
      milestones = [
        { id: crypto.randomUUID(), text: "Literature Review", done: false },
        { id: crypto.randomUUID(), text: "Data Collection", done: false },
        { id: crypto.randomUUID(), text: "Drafting", done: false },
        { id: crypto.randomUUID(), text: "Peer Review", done: false }
      ];
    }

    try {
      await create(r.title, {
        subtitle: r.subtitle, status: "Active", progress: 0, color: "var(--h-projects)", icon: "ph-kanban", tag: "", desc: "",
        milestones, meta: { commits: 0, lang: "—" },
      });
      toast("Project created", "ph-kanban");
    } catch (err) { console.error("Failed to create project:", err); }
  };
  const handleEdit = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getProjectMeta(item);
    const r = await modal.form({ panel: true,
      title: "Edit project", icon: "ph-pencil", accent: "var(--h-projects)", submitLabel: "Save changes",
      fields: [
        { name: "title", label: "Name", defaultValue: item.title, required: true },
        { name: "subtitle", label: "Subtitle", defaultValue: meta.subtitle },
        { name: "tag", label: "Tag", defaultValue: meta.tag, placeholder: "e.g. WORK, PERSONAL" },
        { name: "desc", label: "Description", type: "textarea", defaultValue: meta.desc, placeholder: "What is this project?" },
        { name: "status", label: "Status", type: "select", defaultValue: meta.status, options: [
          { value: "Active", label: "Active" }, { value: "Paused", label: "Paused" }, { value: "Maintained", label: "Maintained" },
        ] },
        { name: "progress", label: "Progress % (0–100)", defaultValue: String(meta.progress) },
      ],
    });
    if (!r) return;
    const progress = Math.max(0, Math.min(100, parseInt(r.progress, 10) || 0));
    try {
      if (r.title !== item.title) await updateFields(item.id, r.title, "project");
      await updateMeta(item.id, { ...meta, subtitle: r.subtitle, tag: r.tag, desc: r.desc, status: r.status, progress });
      toast("Project updated", "ph-check-circle");
    } catch (err) { console.error("Failed to edit project:", err); }
  };
  const handleDelete = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const ok = await modal.confirm({ title: "Delete project", message: `Delete "${item.title}"? You can undo right after.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try {
      const itemLinks = links.filter((l) => l.source_id === item.id || l.target_id === item.id);
      await commands.run(deleteCommand(remove, restore, item, itemLinks, "Delete Project"));
      toast("Project deleted", "ph-trash", { label: "Undo", onClick: () => commands.undo() });
    } catch (err) { console.error("Failed to delete project:", err); }
  };

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-projects)" } as any}>
      <PageHead mod="var(--h-projects)" icon="ph-kanban" kicker="Projects" title="What you're building"
        sub={`${activeCount} active · ${list.length} total`}>
        <div className="seg">
          <button className={cx(viewMode === "list" && "on")} onClick={() => setViewMode("list")}>List</button>
          <button className={cx(viewMode === "gantt" && "on")} onClick={() => setViewMode("gantt")}>Gantt</button>
        </div>
        {viewMode === "gantt" && (
          <div className="seg" aria-label="Gantt zoom">
            <button onClick={() => zoomGantt(-0.5)} disabled={ganttZoom <= 1} title="Zoom out"><I n="ph-minus" w="bold" /></button>
            <button onClick={() => setGanttZoom(1)} title="Reset zoom" style={{ minWidth: 44 }}>{Math.round(ganttZoom * 100)}%</button>
            <button onClick={() => zoomGantt(0.5)} disabled={ganttZoom >= 4} title="Zoom in"><I n="ph-plus" w="bold" /></button>
          </div>
        )}
        <button className="btn primary" onClick={handleNew}><I n="ph-plus" w="bold" /> New project</button>
      </PageHead>
      {!ready ? (
        <div className="muted" style={{ padding: "20px 0" }}>Loading projects...</div>
      ) : list.length === 0 ? (
        <EmptyState icon="ph-kanban" mod="var(--h-projects)" title="No projects yet" sub="Spin up a project to group related work.">
          <button className="btn primary sm" style={{ marginTop: 12 }} onClick={handleNew}><I n="ph-plus" w="bold" /> New project</button>
        </EmptyState>
      ) : viewMode === "gantt" ? (
        <div className="fade-in" style={{ overflowX: "auto", paddingBottom: 20 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 800 * ganttZoom }}>
            <div style={{ display: "flex", borderBottom: "1px solid var(--border)", paddingBottom: 8, color: "var(--text-faint)", fontSize: "var(--fs-sm)" }}>
              <div style={{ width: 240, flexShrink: 0 }}>Project</div>
              <div style={{ flex: 1, display: "flex", position: "relative" }}>
                 <div style={{ flex: 1 }}>Start</div>
                 <div style={{ flex: 1, textAlign: "center" }}>Milestones Progress</div>
                 <div style={{ flex: 1, textAlign: "right" }}>End</div>
              </div>
            </div>
            {list.map(({ item, meta, ms, derivedProgress }) => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border-faint)", paddingBottom: 12 }}>
                 <div style={{ width: 240, flexShrink: 0, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 16 }}>
                    <div className="row gap8" onClick={() => inspect(item.id)} {...clickable(() => inspect(item.id))}>
                      <I n={meta.icon || "ph-kanban"} style={{ color: meta.color || "var(--h-projects)" }} />
                      <span>{item.title}</span>
                    </div>
                 </div>
                 <div style={{ flex: 1, display: "flex", alignItems: "center", position: "relative", height: 24, background: "var(--surface-1)", borderRadius: "var(--r-sm)" }}>
                    <div style={{ width: `${Math.max(5, derivedProgress)}%`, background: meta.color || "var(--h-projects)", height: "100%", borderRadius: "var(--r-sm)", opacity: 0.6, transition: "width 0.3s" }} />
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 8px" }}>
                       {ms.map((m: any) => (
                         <div key={m.id} title={m.text} style={{ width: 12, height: 12, borderRadius: "50%", background: m.done ? "var(--sys-success)" : "var(--surface-2)", border: "2px solid var(--bg)", zIndex: 2, cursor: "pointer" }} onClick={() => toggleMilestone(item, m.id)} {...clickable(() => toggleMilestone(item, m.id))} />
                       ))}
                    </div>
                 </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
      <motion.div variants={listStagger} initial="initial" animate="enter" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(330px,1fr))", gap: 16 }}>
        {list.map(({ item, meta, stats, ms, msDone, derivedProgress, health }) => (
          <motion.div variants={listItem} key={item.id} className="flow-card" style={{ "--mod": meta.color, cursor: "pointer", position: "relative" } as any} onClick={() => inspect(item.id)} {...clickable(() => inspect(item.id))}>
            <div style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 4, zIndex: 10 }}>
              <button className="btn icon sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: 4 }} onClick={(e) => { e.stopPropagation(); addMilestone(item); }} title="Add milestone">
                <I n="ph-flag-banner" style={{ color: "var(--text-faint)" }} />
              </button>
              <button className="btn icon sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: 4 }} onClick={(e) => handleEdit(e, item)} title="Edit">
                <I n="ph-pencil" style={{ color: "var(--text-faint)" }} />
              </button>
              <button className="btn icon sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: 4 }} onClick={(e) => handleDelete(e, item)} title="Delete">
                <I n="ph-trash" style={{ color: "var(--text-faint)" }} />
              </button>
            </div>
            <div className="row gap12" style={{ marginBottom: 12 }}>
              <div className="vault-ico" style={{ "--mod": meta.color, width: 44, height: 44 } as any}><I n={meta.icon} w="fill" /></div>
              <div style={{ flex: 1, minWidth: 0, paddingRight: 84 }}>
                <div className="row gap8">
                  <span style={{ fontWeight: 600, fontSize: "var(--fs-lg)", letterSpacing: "-0.01em" }}>{item.title}</span>
                  {meta.tag && <span className="tag">#{meta.tag}</span>}
                </div>
                <div className="muted" style={{ fontSize: "var(--fs-sm)", marginTop: 1 }}>{meta.subtitle}</div>
              </div>
            </div>
            <div className="muted" style={{ fontSize: "var(--fs-sm)", lineHeight: 1.55, marginBottom: 13, minHeight: 38 }}>{meta.desc}</div>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
              <div className="row gap8">
                <span className="mono-sm" style={{ color: STATUS[meta.status] || "var(--text-faint)" }}>● {meta.status}</span>
                <span className="chip" style={{ "--mod": HEALTH_COLOR[health], height: 20 } as any}><span className="dot"></span>{health}</span>
              </div>
              <span className="mono-sm ghost">{derivedProgress}%{ms.length > 0 && <span> · {msDone}/{ms.length} milestones</span>}</span>
            </div>
            <div className="bar"><i style={{ width: derivedProgress + "%" }}></i></div>
            {ms.length > 0 && (
              <div className="milestone-list" onClick={(e) => e.stopPropagation()}>
                {ms.map((m) => (
                  <div key={m.id} className={cx("milestone-row", m.done && "checked")}>
                    <button className={cx("chk", m.done && "done")} onClick={() => toggleMilestone(item, m.id)} role="checkbox" aria-checked={m.done} aria-label={`Toggle ${m.text}`}><I n="ph-check" w="bold" /></button>
                    <span className="milestone-text">{m.text}</span>
                    <button className="btn icon sm" style={{ padding: 3 }} onClick={() => removeMilestone(item, m.id)} title="Remove"><I n="ph-x" style={{ color: "var(--text-ghost)" }} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="row gap16" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-faint)" }}>
              <span className="mono-sm ghost"><I n="ph-check-square" /> {stats.openTasks}/{stats.tasks}</span>
              <span className="mono-sm ghost"><I n="ph-note" /> {stats.notes}</span>
              <span className="mono-sm ghost"><I n="ph-file" /> {stats.files}</span>
              <span className="mono-sm ghost"><I n="ph-git-commit" /> {meta.meta.commits}</span>
              <span className="mono-sm ghost" style={{ marginLeft: "auto" }}><I n="ph-code" /> {meta.meta.lang}</span>
            </div>
          </motion.div>
        ))}
      </motion.div>
      )}
    </div>
  );
}
