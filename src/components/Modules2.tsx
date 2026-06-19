import React, { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { listStagger, listItem } from "../lib/motionVariants";
import { I, cx, useLoom, clickable } from "../lib/context";
import { Item } from "../ipc/items";
import { useTasks, useCalendar, useBookmarks, useProjects, useHabits, useFiles, useItemStore, useNotes } from "../lib/itemStore";
import { getTaskMeta, getCalendarMeta, getBookmarkMeta, getProjectMeta, getHabitMeta, getFileMeta, dueInfo, Subtask } from "../lib/meta";
import {
  createTasksViewModel, createProjectsViewModel, createHabitsViewModel,
  createCalendarViewModel, createBookmarksViewModel, createFilesViewModel,
  calSameDate,
} from "../lib/viewmodels";
import { deleteCommand, useCommands } from "../lib/commands";
import { useModal } from "./Modal";
import { EmptyState } from "./shared";
import { AsyncButton } from "./ui/AsyncButton";
import { fsReadNoteContent } from "../ipc/fs";
import { encryptFile, decryptFile, indexTextFiles } from "../ipc/content";
import { fsWriteAnyFile } from "../ipc/fs";
import { save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useViewMemory } from "../lib/viewMemory";
import { buildHeatmap, toggleLogDate } from "../lib/heatmap";
import { parseRecurrence, Recurrence } from "../lib/recurrence";

// Task recurrence: the editor picks a key; we persist the canonical {unit, every}
// object the Rust scheduler reads (automation.rs recurring_tick). "none" → cleared.
const RECURRENCE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];
function toRecurrence(key: string): Recurrence | null {
  return !key || key === "none" ? null : parseRecurrence(key);
}
// Map a stored recurrence (object or legacy string) back to a select key.
function recurrenceKey(rec: any): string {
  if (!rec) return "none";
  if (typeof rec === "string") return RECURRENCE_OPTIONS.some((o) => o.value === rec) ? rec : "none";
  const { unit, every } = rec;
  if (unit === "day" && every === 1) return "daily";
  if (unit === "week" && every === 1) return "weekly";
  if (unit === "week" && every === 2) return "biweekly";
  if (unit === "month" && every === 1) return "monthly";
  if (unit === "year" && every === 1) return "yearly";
  return "none";
}


// Local datetime formatted as the value an <input type="datetime-local"> expects.
function toLocalInput(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function PageHead({ mod, kicker, title, sub, children, icon }: {
  mod: string; kicker: string; title: string; sub?: string; children?: React.ReactNode; icon: string;
}) {
  return (
    <div className="page-head">
      <div className="ph-meta">
        <div className="page-kicker" style={{ "--mod": mod } as any}><I n={icon} w="fill" /> {kicker}</div>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

// ---- TASKS ----
export function TasksModule() {
  const { inspect, toast } = useLoom();
  const modal = useModal();
  const commands = useCommands();
  const { items: tasks, create, updateMeta, updateFields, remove, restore, ready } = useTasks();
  const { links, items: allItems } = useItemStore();
  const loading = !ready;
  const [group, setGroup] = useViewMemory("tasks.group", "due");
  const [prio, setPrio] = useViewMemory("tasks.prio", "all");
  
  // Enhancement 17: Pomodoro Timer State
  const [pomoTask, setPomoTask] = useState<string | null>(null);
  const [pomoTime, setPomoTime] = useState(25 * 60);
  const [pomoActive, setPomoActive] = useState(false);

  useEffect(() => {
    if (pomoActive && pomoTime > 0) {
      const timer = setInterval(() => setPomoTime(t => t - 1), 1000);
      return () => clearInterval(timer);
    } else if (pomoTime === 0 && pomoActive) {
      toast("Pomodoro completed! Take a break.", "ph-bell-ringing");
      setPomoActive(false);
    }
  }, [pomoActive, pomoTime, toast]);

  const toggle = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const meta = getTaskMeta(task);
    
    // Enhancement 16: Check Dependencies
    if (meta.blockedBy && !meta.done) {
      const blocker = tasks.find(t => t.id === meta.blockedBy);
      if (blocker && !getTaskMeta(blocker).done) {
        toast(`Blocked by: ${blocker.title}`, "ph-lock");
        return;
      }
    }

    const newDone = !meta.done;
    try {
      await updateMeta(id, { ...meta, done: newDone });
      if (newDone) {
        toast("Task completed", "ph-check-circle");
        
        // Enhancement 15: Recurring tasks
        if (meta.recurrence && meta.recurrence !== "none" && meta.dueDate) {
          const d = new Date(meta.dueDate + "T12:00:00");
          if (meta.recurrence === "daily") d.setDate(d.getDate() + 1);
          if (meta.recurrence === "weekly") d.setDate(d.getDate() + 7);
          if (meta.recurrence === "monthly") d.setMonth(d.getMonth() + 1);
          const nextDate = d.toISOString().split("T")[0];
          
          await create(task.title, { ...meta, done: false, dueDate: nextDate, due: dueInfo(nextDate).label });
          toast(`Next occurrence scheduled for ${nextDate}`, "ph-arrows-clockwise");
        }
      }
    } catch (err) {
      console.error("Failed to toggle task done status:", err);
    }
  };

  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

  const handleNewTask = async () => {
    const r = await modal.form({ panel: true,
      title: "New task", icon: "ph-check-square", accent: "var(--h-tasks)", submitLabel: "Create task",
      fields: [
        { name: "title", label: "Title", placeholder: "What needs doing?", required: true },
        { name: "priority", label: "Priority", type: "select", defaultValue: "med", options: [
          { value: "low", label: "Low" }, { value: "med", label: "Medium" }, { value: "high", label: "High" },
        ] },
        { name: "dueDate", label: "Due date", type: "date", defaultValue: todayISO() },
        { name: "recurrence", label: "Recurrence", type: "select", defaultValue: "none", options: RECURRENCE_OPTIONS },
        { name: "project", label: "Project", defaultValue: "Inbox", placeholder: "Inbox" },
      ],
    });
    if (!r) return;
    
    // Enhancement 14: NLP Parsing
    let finalDate = r.dueDate;
    const lowerTitle = r.title.toLowerCase();
    if (lowerTitle.includes("tomorrow")) {
      const tm = new Date(); tm.setDate(tm.getDate() + 1);
      finalDate = tm.toISOString().split("T")[0];
    } else if (lowerTitle.includes("next week")) {
      const nw = new Date(); nw.setDate(nw.getDate() + 7);
      finalDate = nw.toISOString().split("T")[0];
    }
    // Remove NLP trigger words from title
    const cleanTitle = r.title.replace(/tomorrow/i, "").replace(/next week/i, "").trim();

    try {
      await create(cleanTitle, { done: false, priority: r.priority, dueDate: finalDate, due: dueInfo(finalDate).label, recurrence: toRecurrence(r.recurrence), project: r.project || "Inbox", subtasks: [] });
      toast("Task created", "ph-check-circle");
    } catch (err) {
      console.error("Failed to create task in SQLite:", err);
    }
  };

  const [openSubtasks, setOpenSubtasks] = useState<string | null>(null);

  const addSubtask = async (item: Item) => {
    const r = await modal.form({ panel: true,
      title: "Add subtask", icon: "ph-list-checks", accent: "var(--h-tasks)", submitLabel: "Add",
      fields: [{ name: "text", label: "Subtask", placeholder: "A small step…", required: true }],
    });
    if (!r) return;
    const meta = getTaskMeta(item);
    const subtasks: Subtask[] = [...(meta.subtasks || []), { id: crypto.randomUUID(), text: r.text, done: false }];
    try { await updateMeta(item.id, { ...meta, subtasks }); } catch (err) { console.error(err); }
  };

  const toggleSubtask = async (item: Item, sid: string) => {
    const meta = getTaskMeta(item);
    const subtasks = (meta.subtasks || []).map((s) => s.id === sid ? { ...s, done: !s.done } : s);
    try { await updateMeta(item.id, { ...meta, subtasks }); } catch (err) { console.error(err); }
  };

  const removeSubtask = async (item: Item, sid: string) => {
    const meta = getTaskMeta(item);
    const subtasks = (meta.subtasks || []).filter((s) => s.id !== sid);
    try { await updateMeta(item.id, { ...meta, subtasks }); } catch (err) { console.error(err); }
  };

  const handleEdit = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getTaskMeta(item);
    const r = await modal.form({ panel: true,
      title: "Edit task", icon: "ph-pencil", accent: "var(--h-tasks)", submitLabel: "Save changes",
      fields: [
        { name: "title", label: "Title", defaultValue: item.title, required: true },
        { name: "priority", label: "Priority", type: "select", defaultValue: meta.priority, options: [
          { value: "low", label: "Low" }, { value: "med", label: "Medium" }, { value: "high", label: "High" },
        ] },
        { name: "dueDate", label: "Due date", type: "date", defaultValue: meta.dueDate || "" },
        { name: "recurrence", label: "Recurrence", type: "select", defaultValue: recurrenceKey(meta.recurrence), options: RECURRENCE_OPTIONS },
        { name: "project", label: "Project", defaultValue: meta.project },
        { name: "blockedBy", label: "Blocked By Task ID", defaultValue: meta.blockedBy || "", placeholder: "Task ID (Optional)" },
      ],
    });
    if (!r) return;
    try {
      if (r.title !== item.title) await updateFields(item.id, r.title, "task");
      await updateMeta(item.id, { ...meta, priority: r.priority, dueDate: r.dueDate, recurrence: toRecurrence(r.recurrence), blockedBy: r.blockedBy, due: dueInfo(r.dueDate).label, project: r.project || "Inbox" });
      toast("Task updated", "ph-check-circle");
    } catch (err) { console.error("Failed to edit task:", err); }
  };

  const handleDelete = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const ok = await modal.confirm({ title: "Delete task", message: `Delete “${item.title}”? You can undo right after.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try { 
      const itemLinks = links.filter((l) => l.source_id === item.id || l.target_id === item.id);
      await commands.run(deleteCommand(remove, restore, item, itemLinks, "Delete Task"));
      toast("Task deleted", "ph-trash", { label: "Undo", onClick: () => commands.undo() });
    } catch (err) { console.error("Failed to delete task:", err); }
  };

  const PRIO: Record<string, string> = { high: "var(--sys-danger)", med: "var(--sys-info)", low: "var(--text-faint)" };

  // Read-model (rows, counts, priority filter, grouping) — all derived in the VM.
  const { rows: taskList, openCount, overdueCount, projectCount, visible, groups } = useMemo(
    () => createTasksViewModel({ tasks, links, allItems }, { group, prio }),
    [tasks, links, allItems, group, prio],
  );

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-tasks)" } as any}>
      <PageHead mod="var(--h-tasks)" icon="ph-check-square" kicker="Tasks" title="Today and ahead"
        sub={`${openCount} open across ${projectCount} projects${overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}`}>
        <div className="seg">
          <button className={cx(group === "due" && "on")} onClick={() => setGroup("due")}>By due</button>
          <button className={cx(group === "proj" && "on")} onClick={() => setGroup("proj")}>By project</button>
          <button className={cx(group === "kanban" && "on")} onClick={() => setGroup("kanban")}>Kanban</button>
        </div>
        <div className="seg" aria-label="Filter by priority">
          <button className={cx(prio === "all" && "on")} onClick={() => setPrio("all")}>All</button>
          <button className={cx(prio === "low" && "on")} onClick={() => setPrio("low")}>Low</button>
          <button className={cx(prio === "med" && "on")} onClick={() => setPrio("med")}>Med</button>
          <button className={cx(prio === "high" && "on")} onClick={() => setPrio("high")}>High</button>
        </div>
        <button className="btn primary" onClick={handleNewTask}><I n="ph-plus" w="bold" /> New task</button>
      </PageHead>
      <div style={{ maxWidth: group === "kanban" ? "none" : 760, display: group === "kanban" ? "flex" : "block", gap: 16, overflowX: "auto", paddingBottom: 16 }}>
        {loading ? (
          <div className="muted" style={{ padding: "20px 0" }}>Loading tasks...</div>
        ) : taskList.length === 0 ? (
          <EmptyState icon="ph-check-square" mod="var(--h-tasks)" title="No tasks yet" sub="Create your first task to get moving.">
            <button className="btn primary sm" style={{ marginTop: 12 }} onClick={handleNewTask}><I n="ph-plus" w="bold" /> New task</button>
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon="ph-funnel" mod="var(--h-tasks)" title={`No ${prio} priority tasks`} sub="Switch the filter back to All to see everything." />
        ) : groups.map(([label, items]) => items.length > 0 && (
          <div key={label} style={{ marginBottom: group === "kanban" ? 0 : 26, width: group === "kanban" ? 320 : "auto", flexShrink: 0 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ fontWeight: 600, fontSize: "var(--fs-base)" }}>{label}</span>
              <span className="mono-sm ghost">{items.length}</span>
            </div>
            <motion.div variants={listStagger} initial="initial" animate="enter" style={{ background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: "4px 14px", display: "flex", flexDirection: "column", gap: group === "kanban" ? 8 : 0 }}>
              {items.map((t) => {
                const it = t.raw;
                const expanded = openSubtasks === t.id;
                const subPct = t.subPct;
                return (
                <motion.div variants={listItem} key={t.id} style={{ borderTop: group === "kanban" ? "none" : "1px solid var(--border-faint)", background: group === "kanban" ? "var(--surface-2)" : "transparent", borderRadius: group === "kanban" ? "var(--r-sm)" : 0 }}>
                <div className={cx("wrow", t.done && "checked")}
                  style={{ "--mod": t.color, padding: group === "kanban" ? "12px" : "11px 8px", borderTop: "none", flexDirection: group === "kanban" ? "column" : "row", alignItems: group === "kanban" ? "flex-start" : "center", gap: group === "kanban" ? 8 : 12 } as any}
                  onClick={() => inspect(t.id)} {...clickable(() => inspect(t.id))}>
                  <div className="row gap8" style={{ width: "100%" }}>
                    <button className={cx("chk", t.done && "done")} onClick={(e) => toggle(t.id, e)} role="checkbox" aria-checked={t.done} aria-label={`Mark "${t.title}" ${t.done ? "open" : "complete"}`}><I n="ph-check" w="bold" /></button>
                    <div className="wrow-t" style={{ flex: 1 }}>{t.title}</div>
                  </div>
                  <div className="wrow-main" style={{ width: "100%", display: group === "kanban" ? "flex" : "block", justifyContent: "space-between" }}>
                    <div className="wrow-s">
                      {t.project}
                      {t.blockedBy && <span style={{ color: "var(--sys-danger)" }}> <I n="ph-lock" /> Blocked</span>}
                      {t.recurrence && t.recurrence !== "none" && <span> <I n="ph-arrows-clockwise" /></span>}
                      {t.subtasks.length > 0 && <span> · <I n="ph-list-checks" /> {t.subDone}/{t.subtasks.length}</span>}
                    </div>
                  </div>
                  <div className="row gap8" style={{ marginTop: group === "kanban" ? 8 : 0, width: group === "kanban" ? "100%" : "auto", justifyContent: "flex-end" }}>
                    {t.subtasks.length > 0 && (
                      <button className="btn icon sm" style={{ padding: 4 }} onClick={(e) => { e.stopPropagation(); setOpenSubtasks(expanded ? null : t.id); }} title="Toggle subtasks" aria-expanded={expanded}>
                        <I n={expanded ? "ph-caret-up" : "ph-caret-down"} style={{ color: "var(--text-faint)" }} />
                      </button>
                    )}
                    <span className="mono-sm" style={{ color: PRIO[t.priority] }}>● {t.priority}</span>
                    <span className="wrow-meta" style={{ minWidth: 64, textAlign: "right", color: t.overdue ? "var(--danger-text)" : undefined, fontWeight: t.overdue ? 600 : undefined }}>
                      {t.done ? "done" : t.due}
                    </span>
                    <button className={cx("btn icon sm", pomoTask === t.id && "active")} onClick={(e) => { e.stopPropagation(); setPomoTask(t.id); setPomoActive(true); setPomoTime(25 * 60); }} title="Start Pomodoro">
                      <I n="ph-timer" style={{ color: "var(--h-tasks)" }} />
                    </button>
                    <button className="btn icon sm" style={{ padding: 4 }} onClick={(e) => { e.stopPropagation(); if (it) addSubtask(it); }} title="Add subtask">
                      <I n="ph-list-plus" style={{ color: "var(--text-faint)" }} />
                    </button>
                    <button className="btn icon sm" style={{ padding: 4 }} onClick={(e) => { if (it) handleEdit(e, it); }} title="Edit">
                      <I n="ph-pencil" style={{ color: "var(--text-faint)" }} />
                    </button>
                    <button className="btn icon sm" style={{ padding: 4 }} onClick={(e) => { if (it) handleDelete(e, it); }} title="Delete">
                      <I n="ph-trash" style={{ color: "var(--text-faint)" }} />
                    </button>
                  </div>
                </div>
                {expanded && it && (
                  <div className="subtask-panel">
                    <div className="bar" style={{ marginBottom: 8 }}><i style={{ width: subPct + "%" }} /></div>
                    {t.subtasks.map((s: Subtask) => (
                      <div key={s.id} className={cx("subtask-row", s.done && "checked")}>
                        <button className={cx("chk", s.done && "done")} onClick={() => toggleSubtask(it, s.id)} role="checkbox" aria-checked={s.done} aria-label={`Toggle ${s.text}`}><I n="ph-check" w="bold" /></button>
                        <span className="subtask-text">{s.text}</span>
                        <button className="btn icon sm" style={{ padding: 3 }} onClick={() => removeSubtask(it, s.id)} title="Remove subtask"><I n="ph-x" style={{ color: "var(--text-ghost)" }} /></button>
                      </div>
                    ))}
                    <button className="btn sm" style={{ marginTop: 4 }} onClick={() => addSubtask(it)}><I n="ph-plus" /> Add subtask</button>
                  </div>
                )}
                </motion.div>
              );})}
            </motion.div>
          </div>
        ))}
      </div>
      
      {/* Enhancement 17: Integrated Pomodoro Timer */}
      {pomoTask && (
        <div style={{ position: "fixed", bottom: 20, right: 20, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: 12, boxShadow: "var(--shadow-lg)", zIndex: 100, display: "flex", gap: 12, alignItems: "center" }} className="fade-in">
          <div className="vault-ico" style={{ "--mod": "var(--sys-danger)", width: 32, height: 32, borderRadius: "50%" } as any}><I n="ph-timer" w="fill" /></div>
          <div>
            <div className="mono-sm" style={{ fontWeight: 600, fontSize: "var(--fs-lg)" }}>{Math.floor(pomoTime / 60)}:{(pomoTime % 60).toString().padStart(2, "0")}</div>
            <div className="muted" style={{ fontSize: "var(--fs-xs)", maxWidth: 120, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {tasks.find(t => t.id === pomoTask)?.title || "Task"}
            </div>
          </div>
          <div className="row gap4">
            <button className="btn icon sm" onClick={() => setPomoActive(!pomoActive)} title={pomoActive ? "Pause" : "Resume"}><I n={pomoActive ? "ph-pause" : "ph-play"} /></button>
            <button className="btn icon sm" onClick={() => { setPomoActive(false); setPomoTask(null); }} title="Close"><I n="ph-x" /></button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- PROJECTS ----
export function ProjectsModule() {
  const { inspect, toast } = useLoom();
  const modal = useModal();
  const commands = useCommands();
  const { items, create, updateMeta, updateFields, remove, restore, ready } = useProjects();
  const { links, items: allItems } = useItemStore();
  const STATUS: Record<string, string> = { Active: "var(--sys-success)", Paused: "var(--sys-warning)", Maintained: "var(--sys-info)" };
  // Read-model: per-project stats, milestone-derived progress, and health — all in the VM.
  const { rows: list, activeCount } = useMemo(
    () => createProjectsViewModel({ projects: items, links, allItems }), [items, links, allItems],
  );
  const [viewMode, setViewMode] = useViewMemory("projects.viewMode", "list");
  // Gantt zoom: scales the chart's horizontal scale so a dense roadmap can be spread
  // out and scrolled, or pulled in to fit. Persisted per the view-memory convention.
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
          { value: "none", label: "Blank" },
          { value: "software", label: "Software Project" },
          { value: "marketing", label: "Marketing Campaign" },
          { value: "research", label: "Research Paper" }
        ] },
      ],
    });
    if (!r) return;
    
    // Enhancement 18: Project Templates
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
        milestones,
        meta: { commits: 0, lang: "—" },
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
      // Spread existing meta — keeps icon, color, links, and meta.{tasks,notes,…}.
      await updateMeta(item.id, { ...meta, subtitle: r.subtitle, tag: r.tag, desc: r.desc, status: r.status, progress });
      toast("Project updated", "ph-check-circle");
    } catch (err) { console.error("Failed to edit project:", err); }
  };
  const handleDelete = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const ok = await modal.confirm({ title: "Delete project", message: `Delete “${item.title}”? You can undo right after.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
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
        // Enhancement 19: Gantt Chart Visualization
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

// ---- HABITS ----
export function HabitsModule() {
  const { toast } = useLoom();
  const modal = useModal();
  const commands = useCommands();
  const { items, create, updateMeta, updateFields, remove, restore, ready } = useHabits();
  const { links } = useItemStore();
  // Read-model: per-habit done/pct/daysLeft + XP/level gamification — all in the VM.
  const { rows: list, longest, level, totalXP, xpForNext, xpProgress } = useMemo(
    () => createHabitsViewModel({ habits: items }), [items],
  );

  const DURATIONS = [
    { value: "7", label: "1 week" }, { value: "14", label: "2 weeks" }, { value: "30", label: "30 days" },
    { value: "66", label: "66 days" }, { value: "90", label: "90 days" },
  ];

  const handleNew = async () => {
    const r = await modal.form({ panel: true,
      title: "New habit", icon: "ph-pulse", accent: "var(--h-habits)", submitLabel: "Create habit",
      fields: [
        { name: "title", label: "Name", placeholder: "Habit name…", required: true },
        { name: "goal", label: "Goal", defaultValue: "Daily", placeholder: "e.g. Daily, 4×/week" },
        { name: "duration", label: "Challenge duration", type: "select", defaultValue: "30", options: DURATIONS },
      ],
    });
    if (!r) return;
    try {
      await create(r.title, {
        goal: r.goal || "Daily", streak: 0, color: "var(--h-habits)", week: [0, 0, 0, 0, 0, 0, 0],
        duration: parseInt(r.duration, 10) || 30, bestStreak: 0, totalDone: 0, startDate: new Date().toISOString(),
      });
      toast("Habit created", "ph-pulse");
    }
    catch (err) { console.error("Failed to create habit:", err); }
  };
  const handleEdit = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getHabitMeta(item);
    const r = await modal.form({ panel: true,
      title: "Edit habit", icon: "ph-pencil", accent: "var(--h-habits)", submitLabel: "Save changes",
      fields: [
        { name: "title", label: "Name", defaultValue: item.title, required: true },
        { name: "goal", label: "Goal", defaultValue: meta.goal, placeholder: "e.g. Daily, 4×/week" },
        { name: "duration", label: "Challenge duration", type: "select", defaultValue: String(meta.duration), options: DURATIONS },
      ],
    });
    if (!r) return;
    try {
      if (r.title !== item.title) await updateFields(item.id, r.title, "habit");
      // Spread existing meta — keeps streak, week, color, links.
      await updateMeta(item.id, { ...meta, goal: r.goal || "Daily", duration: parseInt(r.duration, 10) || meta.duration });
      toast("Habit updated", "ph-check-circle");
    } catch (err) { console.error("Failed to edit habit:", err); }
  };

  const toggleToday = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getHabitMeta(item);
    const week = [...meta.week];
    const today = week.length - 1; // last slot = today
    const nowOn = !week[today];
    week[today] = nowOn ? 1 : 0;
    const streak = Math.max(0, meta.streak + (nowOn ? 1 : -1));
    const bestStreak = Math.max(meta.bestStreak, streak);
    const totalDone = Math.max(0, (meta.totalDone || 0) + (nowOn ? 1 : -1));
    // Per-day completion log — the source for the 365-day heatmap. Kept in sync with
    // the week/streak counters so a check-in updates both views from one click.
    const log = toggleLogDate((meta as any).log || [], new Date());
    try {
      await updateMeta(item.id, { ...meta, week, streak, bestStreak, totalDone, log });
      if (nowOn) {
        if (streak > 0 && streak === meta.duration) toast(`${meta.duration}-day challenge complete! 🏆`, "ph-trophy");
        else if (streak > 0 && streak % 7 === 0) toast(`${streak} day streak — keep going! 🔥`, "ph-flame");
        else toast("Habit checked", "ph-flame");
      }
    }
    catch (err) { console.error("Failed to toggle habit:", err); }
  };
  const togglePause = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getHabitMeta(item);
    try { await updateMeta(item.id, { ...meta, paused: !meta.paused }); toast(meta.paused ? "Habit resumed" : "Habit paused — streak frozen", meta.paused ? "ph-play" : "ph-pause"); }
    catch (err) { console.error("Failed to pause habit:", err); }
  };

  const handleDelete = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const ok = await modal.confirm({ title: "Delete habit", message: `Delete “${item.title}”? You can undo right after.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try {
      const itemLinks = links.filter((l) => l.source_id === item.id || l.target_id === item.id);
      await commands.run(deleteCommand(remove, restore, item, itemLinks, "Delete Habit"));
      toast("Habit deleted", "ph-trash", { label: "Undo", onClick: () => commands.undo() });
    } catch (err) { console.error("Failed to delete habit:", err); }
  };

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-habits)" } as any}>
      <PageHead mod="var(--h-habits)" icon="ph-pulse" kicker="Habits" title="Consistency over intensity"
        sub={`${list.length} habits tracked · longest streak ${longest} days`}>
        <div className="seg" style={{ background: "transparent", border: "none", boxShadow: "none", alignItems: "center", gap: 12 }}>
          <div style={{ textAlign: "right", lineHeight: 1.2 }}>
            <div style={{ fontSize: "var(--fs-xs)", fontWeight: 600, color: "var(--h-habits)" }}>Lvl {level}</div>
            <div className="mono-sm ghost" style={{ fontSize: "var(--fs-2xs)" }}>{totalXP} / {xpForNext} XP</div>
          </div>
          <div className="ring" style={{ "--mod": "var(--h-habits)", "--p": xpProgress, width: 36, height: 36 } as any} title={`${xpProgress}% to next level`}></div>
        </div>
        <button className="btn primary" onClick={handleNew}><I n="ph-plus" w="bold" /> New habit</button>
      </PageHead>
      {!ready ? (
        <div className="muted" style={{ padding: "20px 0" }}>Loading habits...</div>
      ) : list.length === 0 ? (
        <EmptyState icon="ph-pulse" mod="var(--h-habits)" title="No habits yet" sub="Track a daily habit and build a streak.">
          <button className="btn primary sm" style={{ marginTop: 12 }} onClick={handleNew}><I n="ph-plus" w="bold" /> New habit</button>
        </EmptyState>
      ) : (
      <div className="col gap12" style={{ maxWidth: 860 }}>
        {list.map(({ item, meta, doneToday, pct, daysLeft }) => {
          return (
          <div key={item.id} className="flow-card" style={{ "--mod": meta.color, opacity: meta.paused ? 0.6 : 1 } as any}>
            <div className="row gap12">
              <div className="ring" style={{ "--mod": meta.color, "--p": pct } as any} title={`${meta.streak} of ${meta.duration} days`}>
                <span>{pct}%</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row gap8">
                  <span style={{ fontWeight: 600, fontSize: "var(--fs-base)" }}>{item.title}</span>
                  <span className="chip" style={{ "--mod": meta.color, height: 22 } as any}><span className="dot"></span>{meta.goal}</span>
                  <span className="chip" style={{ height: 22 }}><I n="ph-target" /> {meta.duration}-day</span>
                  {meta.paused && <span className="chip" style={{ "--mod": "var(--sys-warning)", height: 22 } as any}><I n="ph-pause" /> Paused</span>}
                </div>
                {/* Challenge progress — one cell per day of the selected duration, laid out
                    on a grid whose columns flex to fill the card's full width. Short
                    challenges (7/14-day) become a single row of wide segments; longer ones
                    (30/66/90-day) wrap into evenly-sized rows. Capping at 15 columns keeps
                    cells legible at any length. Only the current streak (the last N
                    consecutive completed days) is shown as done — no fabricated activity. */}
                <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: `repeat(${Math.min(meta.duration, 15)}, 1fr)`, gap: 4 }}>
                  {Array.from({ length: meta.duration }).map((_, i) => {
                    const isDone = i >= meta.duration - meta.streak;
                    return (
                      <div key={i} style={{ height: 14, borderRadius: 3, background: isDone ? meta.color : "var(--surface-3)" }} title={isDone ? `Day ${i + 1} · completed` : `Day ${i + 1}`}></div>
                    );
                  })}
                </div>
                {/* Real 365-day activity heatmap, built from the per-day completion log
                    (GitHub-style). Empty for habits with no logged check-ins yet; it
                    fills in from the first "Today" click. Scrolls horizontally so the
                    full year never overflows the card. */}
                {(() => {
                  const hm = buildHeatmap((meta as any).log || [], { days: 365 });
                  if (hm.total === 0) return null;
                  return (
                    <div style={{ marginTop: 12 }}>
                      <div className="row gap12" style={{ marginBottom: 6 }}>
                        <span className="mono-sm ghost" style={{ fontSize: "var(--fs-2xs)" }}>last year · {hm.total} check-ins</span>
                        <span className="mono-sm ghost" style={{ fontSize: "var(--fs-2xs)" }}><I n="ph-flame" /> {hm.currentStreak}d now · best {hm.longestStreak}d</span>
                      </div>
                      <div style={{ display: "flex", gap: 2, overflowX: "auto", paddingBottom: 2 }}>
                        {hm.weeks.map((wk, wi) => (
                          <div key={wi} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            {wk.map((cell, ci) => (
                              <div key={ci}
                                title={cell.date ? `${cell.date}${cell.count ? ` · ${cell.count}` : ""}` : ""}
                                style={{
                                  width: 9, height: 9, borderRadius: 2,
                                  background: cell.level === 0 ? "var(--surface-3)" : meta.color,
                                  opacity: cell.level === 0 ? (cell.inRange ? 1 : 0.25) : 0.25 + cell.level * 0.1875,
                                }} />
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                <div className="row gap12" style={{ marginTop: 8 }}>
                  <span className="mono-sm ghost"><I n="ph-trophy" /> best {meta.bestStreak}</span>
                  <span className="mono-sm ghost"><I n="ph-check-circle" /> {meta.totalDone} total</span>
                  <span className="mono-sm ghost"><I n="ph-hourglass" /> {daysLeft === 0 ? "challenge complete!" : `${daysLeft} days to goal`}</span>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="mono-sm" style={{ color: meta.color, fontSize: "var(--fs-2xl)", fontWeight: 600 }}><I n="ph-flame" w="fill" /> {meta.streak}</div>
                <div className="ghost mono-sm" style={{ fontSize: "var(--fs-2xs)" }}>day streak</div>
              </div>
              <div className="row gap6" style={{ marginLeft: 6 }}>
                <button className={cx("btn sm", doneToday && "primary")} disabled={meta.paused} onClick={(e) => toggleToday(e, item)} title={meta.paused ? "Resume to check in" : "Toggle today"}>
                  <I n="ph-check" w="bold" /> {doneToday ? "Done" : "Today"}
                </button>
                <button className={cx("btn icon sm", meta.paused && "active")} onClick={(e) => togglePause(e, item)} title={meta.paused ? "Resume habit" : "Pause habit (freeze streak)"}>
                  <I n={meta.paused ? "ph-play" : "ph-pause"} style={{ color: "var(--text-faint)" }} />
                </button>
                <button className="btn icon sm" onClick={(e) => handleEdit(e, item)} title="Edit">
                  <I n="ph-pencil" style={{ color: "var(--text-faint)" }} />
                </button>
                <button className="btn icon sm" onClick={(e) => handleDelete(e, item)} title="Delete">
                  <I n="ph-trash" style={{ color: "var(--text-faint)" }} />
                </button>
              </div>
            </div>
          </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

// ---- CALENDAR ----
export function CalendarModule() {
  const { inspect, toast } = useLoom();
  const modal = useModal();
  const { items, create, remove, ready } = useCalendar();
  const { links } = useItemStore();
  const loading = !ready;
  const [view, setView] = useState<"day" | "week" | "month" | "agenda">("week");

  const { items: allTasks } = useTasks();
  // Read-model: events projection, week/day/month buckets, agenda grouping, unscheduled
  // tasks, and the week scaffold — all in the VM. Date-grid constants stay below.
  const vm = useMemo(
    () => createCalendarViewModel({ calendar: items, links, tasks: allTasks }, { view, now: new Date() }),
    [items, links, allTasks, view],
  );
  const { today, todayCol, weekDates, headerTitle, weekBlocks, dayBlocks, monthCells, agenda, unscheduledTasks, eventsOn } = vm;

  // Export the calendar to a standard iCalendar (.ics) file — importable by Google
  // Calendar, Outlook, Apple Calendar, etc. Real export, no fake sync.
  const icsDate = (iso: string) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  };
  const icsEscape = (s: string) => (s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const handleSync = async () => {
    if (items.length === 0) { toast("No events to export.", "ph-calendar-x"); return; }
    const dest = await save({
      title: "Export Calendar (.ics)", defaultPath: "loom-calendar.ics",
      filters: [{ name: "iCalendar", extensions: ["ics"] }],
    });
    if (!dest) return;
    try {
      const stamp = icsDate(new Date().toISOString());
      const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//LOOM//Calendar//EN", "CALSCALE:GREGORIAN"];
      for (const ev of items) {
        const m = getCalendarMeta(ev);
        const start = icsDate(m.startDate);
        const end = icsDate(m.endDate) || start;
        if (!start) continue;
        lines.push("BEGIN:VEVENT");
        lines.push(`UID:${ev.id}@loom`);
        if (stamp) lines.push(`DTSTAMP:${stamp}`);
        lines.push(`DTSTART:${start}`);
        if (end) lines.push(`DTEND:${end}`);
        lines.push(`SUMMARY:${icsEscape(ev.title)}`);
        if (m.description) lines.push(`DESCRIPTION:${icsEscape(m.description)}`);
        if (m.location) lines.push(`LOCATION:${icsEscape(m.location)}`);
        lines.push("END:VEVENT");
      }
      lines.push("END:VCALENDAR");
      await fsWriteAnyFile(dest, lines.join("\r\n"));
      toast(`Exported ${items.length} event(s) to .ics`, "ph-calendar-check");
    } catch (e) {
      console.error("ICS export failed:", e);
      toast("Calendar export failed.", "ph-warning");
    }
  };

  // Date-grid scaffold constants (pure view layout, not data). today/todayCol/weekDates/
  // headerTitle come from the VM above; sameDate is the shared VM util.
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const sameDate = calSameDate;

  const handleNewEvent = async () => {
    const def = new Date(); def.setHours(10, 0, 0, 0);
    const r = await modal.form({ panel: true,
      title: "New event", icon: "ph-calendar-plus", accent: "var(--h-calendar)", submitLabel: "Create event",
      fields: [
        { name: "title", label: "Title", placeholder: "Event title…", required: true },
        { name: "start", label: "Starts", type: "datetime-local", defaultValue: toLocalInput(def), required: true },
      ],
    });
    if (!r) return;
    const startDate = new Date(r.start); // datetime-local value is local time
    if (isNaN(startDate.getTime())) return;
    const endDate = new Date(startDate.getTime() + 3600000); // +1 hour
    try {
      await create(r.title, {
        startDate: startDate.toISOString(), endDate: endDate.toISOString(), allDay: false,
        description: "", location: "", tags: "", sub: "Event · 1h", color: "var(--h-calendar)",
      });
      toast("Event created", "ph-calendar");
    } catch (err) {
      console.error("Failed to create calendar event:", err);
    }
  };

  // Enhancement 22: Time Blocking
  const handleDropToTime = async (e: React.DragEvent, dateObj: Date) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData("application/x-loom-task");
    if (!taskId) return;
    const task = allTasks.find(t => t.id === taskId);
    if (!task) return;
    
    const endDate = new Date(dateObj.getTime() + 3600000);
    try {
      await create(`Timeblock: ${task.title}`, {
        startDate: dateObj.toISOString(), endDate: endDate.toISOString(), allDay: false,
        description: `Blocked time for task: ${task.title}`, location: "", tags: "", sub: "Task Block · 1h", color: "var(--h-tasks)",
      });
      toast(`Time blocked for: ${task.title}`, "ph-calendar-plus");
    } catch (err) {
      console.error(err);
    }
  };


  const handleDelete = async (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation();
    const ok = await modal.confirm({ title: "Delete event", message: `Delete “${title}”? This cannot be undone.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try { await remove(id); toast("Event deleted", "ph-trash"); }
    catch (err) { console.error("Failed to delete event:", err); }
  };

  // Drag-to-unschedule: dropping a calendar block onto the Unscheduled tray removes
  // it from the schedule. It's a soft-delete, so it's recoverable from Settings →
  // Recovery → Deletion history if it was dropped by mistake.
  const [unscheduleHot, setUnscheduleHot] = useState(false);
  const handleUnschedule = async (e: React.DragEvent) => {
    e.preventDefault();
    setUnscheduleHot(false);
    const eventId = e.dataTransfer.getData("application/x-loom-event");
    if (!eventId) return; // a dragged unscheduled task lands here = no-op
    const ev = items.find((it) => it.id === eventId);
    try {
      await remove(eventId);
      toast(`Unscheduled${ev ? ` “${ev.title}”` : ""}`, "ph-calendar-x");
    } catch (err) { console.error("Failed to unschedule:", err); }
  };

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-calendar)" } as any}>
      <PageHead mod="var(--h-calendar)" icon="ph-calendar-dots" kicker="Calendar" title={headerTitle}
        sub="Time-blocked schedule. Events link to the tasks, projects, and media behind them.">
        <div className="seg">
          <button className={cx(view === "day" && "on")} onClick={() => setView("day")}>Day</button>
          <button className={cx(view === "week" && "on")} onClick={() => setView("week")}>Week</button>
          <button className={cx(view === "month" && "on")} onClick={() => setView("month")}>Month</button>
          <button className={cx(view === "agenda" && "on")} onClick={() => setView("agenda")}>Agenda</button>
        </div>
        <AsyncButton className="btn outline" onClick={handleSync} icon="ph-export" loadingLabel="Exporting..." title="Export all events to an .ics file">Export .ics</AsyncButton>
        <button className="btn primary" onClick={handleNewEvent}><I n="ph-plus" w="bold" /> Event</button>
      </PageHead>
      <div style={{ display: "flex", gap: 16, height: "100%", alignItems: "flex-start" }}>
        <div style={{ flex: 1, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-xl)", overflow: "hidden" }}>
        {loading ? (
          <div className="muted" style={{ padding: "20px 16px" }}>Loading calendar...</div>
        ) : items.length === 0 ? (
          <EmptyState icon="ph-calendar-dots" mod="var(--h-calendar)" title="No events yet" sub="Schedule something to see it on the calendar.">
            <button className="btn primary sm" style={{ marginTop: 12 }} onClick={handleNewEvent}><I n="ph-plus" w="bold" /> New event</button>
          </EmptyState>
        ) : view === "week" ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "56px repeat(7,1fr)", borderBottom: "1px solid var(--border)" }}>
              <div></div>
              {dayNames.map((d, i) => {
                const isToday = sameDate(weekDates[i], today);
                return (
                  <div key={d} style={{ padding: "12px 10px", textAlign: "center", borderLeft: "1px solid var(--border-faint)", background: isToday ? "var(--accent-soft)" : "transparent" }}>
                    <div className="mono-sm ghost" style={{ fontSize: "var(--fs-2xs)" }}>{d.toUpperCase()}</div>
                    <div style={{ fontSize: "var(--fs-2xl)", fontWeight: 600, color: isToday ? "var(--accent-text)" : "var(--text)" }}>{weekDates[i].getDate()}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "56px repeat(7,1fr)", position: "relative" }}>
              <div>
                {hours.map((h) => (
                  <div key={h} style={{ height: 50, padding: "2px 8px", textAlign: "right", borderTop: "1px solid var(--border-faint)" }}>
                    <span className="mono-sm ghost" style={{ fontSize: "var(--fs-2xs)" }}>{h}:00</span>
                  </div>
                ))}
              </div>
              {dayNames.map((_d, di) => (
                <div key={di} style={{ borderLeft: "1px solid var(--border-faint)", position: "relative", background: di === todayCol ? "color-mix(in oklch, var(--accent) 4%, transparent)" : "transparent" }}>
                  {hours.map((h) => {
                    const blockDate = new Date(weekDates[di]); blockDate.setHours(h, 0, 0, 0);
                    return (
                      <div key={h} 
                        style={{ height: 50, borderTop: "1px solid var(--border-faint)" }} 
                        onDragOver={e => e.preventDefault()} 
                        onDrop={e => handleDropToTime(e, blockDate)}></div>
                    );
                  })}
                  {weekBlocks.filter((b) => b.day === di).map((b, i) => (
                    <EventBlock key={i} b={b} onOpen={() => b.links && b.links.length > 0 && inspect(b.links[0])} onDelete={(e) => handleDelete(e, b.id, b.title)} />
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : view === "day" ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "56px 1fr", borderBottom: "1px solid var(--border)" }}>
              <div></div>
              <div style={{ padding: "12px 10px", textAlign: "center", borderLeft: "1px solid var(--border-faint)", background: "var(--accent-soft)" }}>
                <div className="mono-sm ghost" style={{ fontSize: "var(--fs-2xs)" }}>{dayNames[todayCol].toUpperCase()}</div>
                <div style={{ fontSize: "var(--fs-2xl)", fontWeight: 600, color: "var(--accent-text)" }}>{today.getDate()}</div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "56px 1fr", position: "relative" }}>
              <div>
                {hours.map((h) => (
                  <div key={h} style={{ height: 50, padding: "2px 8px", textAlign: "right", borderTop: "1px solid var(--border-faint)" }}>
                    <span className="mono-sm ghost" style={{ fontSize: "var(--fs-2xs)" }}>{h}:00</span>
                  </div>
                ))}
              </div>
              <div style={{ borderLeft: "1px solid var(--border-faint)", position: "relative", background: "color-mix(in oklch, var(--accent) 4%, transparent)" }}>
                {hours.map((h) => {
                  const blockDate = new Date(today); blockDate.setHours(h, 0, 0, 0);
                  return (
                    <div key={h} 
                      style={{ height: 50, borderTop: "1px solid var(--border-faint)" }} 
                      onDragOver={e => e.preventDefault()} 
                      onDrop={e => handleDropToTime(e, blockDate)}></div>
                  );
                })}
                {dayBlocks.length === 0 && <div className="muted" style={{ position: "absolute", top: 12, left: 12, fontSize: "var(--fs-sm)" }}>Nothing scheduled today.</div>}
                {dayBlocks.map((b, i) => (
                  <EventBlock key={i} b={b} onOpen={() => b.links && b.links.length > 0 && inspect(b.links[0])} onDelete={(e) => handleDelete(e, b.id, b.title)} />
                ))}
              </div>
            </div>
          </>
        ) : view === "month" ? (
          <div style={{ padding: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", marginBottom: 6 }}>
              {dayNames.map((d) => <div key={d} className="mono-sm ghost" style={{ textAlign: "center", fontSize: "var(--fs-2xs)", padding: "4px 0" }}>{d.toUpperCase()}</div>)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6 }}>
              {monthCells.map((d, i) => (
                <div key={i} style={{ minHeight: 84, borderRadius: "var(--r-md)", border: d ? "1px solid var(--border-faint)" : "none", padding: d ? 6 : 0, background: d && sameDate(d, today) ? "var(--accent-soft)" : d ? "var(--surface-2)" : "transparent" }}>
                  {d && (
                    <>
                      <div style={{ fontSize: "var(--fs-sm)", fontWeight: 600, marginBottom: 4, color: sameDate(d, today) ? "var(--accent-text)" : "var(--text-faint)" }}>{d.getDate()}</div>
                      <div className="col" style={{ gap: 3 }}>
                        {eventsOn(d).slice(0, 3).map((e) => (
                          <div key={e.id} onClick={() => e.links && e.links.length > 0 && inspect(e.links[0])} {...clickable(() => { if (e.links && e.links.length > 0) inspect(e.links[0]) })}
                            title={`${e.time} ${e.title}`}
                            style={{ fontSize: "var(--fs-2xs)", padding: "2px 5px", borderRadius: "var(--r-xs)", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", background: `color-mix(in oklch, ${e.color} 20%, var(--surface-3))`, borderLeft: `2px solid ${e.color}` }}>
                            {e.title}
                          </div>
                        ))}
                        {eventsOn(d).length > 3 && <div className="mono-sm ghost" style={{ fontSize: "var(--fs-3xs)" }}>+{eventsOn(d).length - 3} more</div>}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          // Agenda — upcoming list grouped by day (VM); render only.
          <div style={{ padding: "8px 0" }}>
            {agenda.length === 0 ? (
              <div className="muted" style={{ padding: "24px 18px" }}>Nothing scheduled ahead. Add an event to fill your agenda.</div>
            ) : agenda.map((g) => (
              <div key={g.key} className="agenda-day">
                <div className="agenda-day-head">
                  <span className="adh-dow">{g.date.toLocaleDateString([], { weekday: "long" })}</span>
                  <span className="adh-date">{g.date.toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                  {sameDate(g.date, new Date()) && <span className="tag">Today</span>}
                  <span className="mono-sm ghost" style={{ marginLeft: "auto" }}>{g.items.length} event{g.items.length > 1 ? "s" : ""}</span>
                </div>
                {g.items.map((e) => (
                  <div key={e.id} className="agenda-list-row" style={{ "--mod": e.color } as any} onClick={() => e.links && e.links.length > 0 ? inspect(e.links[0]) : undefined} {...clickable(() => { if (e.links && e.links.length > 0) inspect(e.links[0]) })}>
                    <span className="agenda-list-time">{e.time}</span>
                    <span className="agenda-list-bar" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="wrow-t">{e.title}</div>
                      <div className="wrow-s">{e.sub}</div>
                    </div>
                    <button className="btn icon sm" onClick={(ev) => handleDelete(ev, e.id, e.title)} title="Delete"><I n="ph-trash" style={{ color: "var(--text-faint)" }} /></button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Enhancement 22: Time Blocking Sidebar — also the drag-to-unschedule drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); if (!unscheduleHot) setUnscheduleHot(true); }}
        onDragLeave={() => setUnscheduleHot(false)}
        onDrop={handleUnschedule}
        style={{ width: 260, flexShrink: 0, padding: "16px 16px", background: unscheduleHot ? "var(--accent-soft)" : "var(--surface-1)", border: `1px ${unscheduleHot ? "dashed var(--accent)" : "solid var(--border)"}`, borderRadius: "var(--r-xl)", transition: "background 0.15s, border-color 0.15s" }}>
        <h3 className="mono-sm ghost" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
          Unscheduled Tasks
          <span className="badge">{unscheduledTasks.length}</span>
        </h3>
        <p className="ghost" style={{ fontSize: "var(--fs-sm)", marginBottom: 16 }}>
          {unscheduleHot ? "Drop to unschedule this event." : "Drag a task onto the calendar to block time — or drag an event here to unschedule it."}
        </p>
        <div className="col gap8">
          {unscheduledTasks.slice(0, 15).map(t => (
            <div key={t.id} draggable onDragStart={e => { e.dataTransfer.setData("application/x-loom-task", t.id); }} 
                 style={{ padding: "10px 12px", background: "var(--surface-2)", border: "1px solid var(--border-faint)", borderRadius: "var(--r-md)", cursor: "grab", fontSize: "var(--fs-sm)", display: "flex", gap: 8, alignItems: "center" }}>
              <I n="ph-dots-six-vertical" style={{ color: "var(--text-faint)" }} /> 
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</span>
            </div>
          ))}
          {unscheduledTasks.length === 0 && <div className="muted" style={{ fontSize: "var(--fs-sm)", textAlign: "center", padding: "20px 0" }}>All tasks are scheduled!</div>}
        </div>
      </div>
    </div>
    </div>
  );
}

// Absolutely-positioned event block shared by Week + Day grids.
function EventBlock({ b, onOpen, onDelete }: { b: any; onOpen: () => void; onDelete: (e: React.MouseEvent) => void }) {
  return (
    <div onClick={onOpen} {...clickable(onOpen)}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("application/x-loom-event", b.id); e.dataTransfer.effectAllowed = "move"; }}
      title="Drag to the Unscheduled tray to unschedule"
      style={{
        position: "absolute", left: 4, right: 4, top: (b.h - 8) * 50 + 1, height: b.dur * 50 - 3,
        background: `color-mix(in oklch, ${b.color} 18%, var(--surface-3))`,
        borderLeft: `3px solid ${b.color}`, borderRadius: "var(--r-sm)", padding: "5px 8px", cursor: "pointer", overflow: "hidden",
      }}>
      <button className="btn icon sm" style={{ position: "absolute", top: 2, right: 2, zIndex: 10, background: "transparent", border: "none", padding: 2 }} onClick={onDelete} title="Delete">
        <I n="ph-x" style={{ color: "var(--text-faint)", fontSize: "var(--fs-2xs)" }} />
      </button>
      <div style={{ fontSize: "var(--fs-xs)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingRight: 12 }}>{b.title}</div>
      <div className="mono-sm" style={{ fontSize: "var(--fs-3xs)", color: "var(--text-faint)" }}>{b.time}</div>
    </div>
  );
}

// ---- BOOKMARKS ----
import { openUrl } from "@tauri-apps/plugin-opener";
import { TYPE_ICON, TYPE_LABEL } from "../lib/typeMeta";
import { ReaderView } from "./ReaderView";
import { fetchReadableArticle, ReadableArticle } from "../ipc/content";


export function BookmarksModule() {
  const { inspect, toast } = useLoom();
  const modal = useModal();
  const { items, create, updateMeta, updateFields, remove, ready } = useBookmarks();
  const { resolve, workspaceId, refresh } = useItemStore();
  const notes = useNotes();
  const loading = !ready;
  const [kind, setKind] = useState<"all" | "web" | "app">("all");
  const [readerUrl, setReaderUrl] = useState<string | null>(null);
  // Read-model: kind filter + per-card internal/external target resolution — in the VM.
  const { cards } = useMemo(() => createBookmarksViewModel({ bookmarks: items, resolve }, { kind }), [items, resolve, kind]);

  // Save an extracted article as a Note on disk, then a web bookmark pointing at the
  // source.
  const clipArticle = async (article: ReadableArticle) => {
    if (!workspaceId) return;
    try {
      const note = await notes.create(article.title || "Clipped article");
      const header = `<h1>${article.title}</h1>` +
        `<p class="muted"><a href="${article.url}">${article.url}</a></p><hr/>`;
      await notes.writeNoteContent(note.id, header + article.html);
      await create(article.title || article.url, {
        url: article.url, createdAt: new Date().toISOString(), tags: ["clipped"],
        desc: article.excerpt,
      });
      await refresh();
      toast("Clipped to Notes + Bookmarks", "ph-scissors");
      setReaderUrl(null);
    } catch (err) {
      console.error("Clip failed:", err);
      toast("Couldn't save the clip.", "ph-warning");
    }
  };

  // Web Clipper: prompt for a URL, fetch + extract it, then persist as note + bookmark.
  const handleWebClipper = async () => {
    const r = await modal.form({ panel: true,
      title: "Web Clipper", icon: "ph-scissors", accent: "var(--h-bookmarks)", submitLabel: "Fetch & clip",
      fields: [{ name: "url", label: "Page URL", type: "url", defaultValue: "https://", placeholder: "https://…", required: true }],
    });
    if (!r) return;
    toast("Fetching page…", "ph-download");
    try {
      const article = await fetchReadableArticle(r.url);
      await clipArticle(article);
    } catch (err) {
      console.error("Web clip failed:", err);
      modal.confirm({ title: "Clip failed", message: String(err), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    }
  };

  const handleOpenUrl = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    try { await openUrl(url); }
    catch (err) { console.error("Failed to open URL:", err); toast("Could not open the link.", "ph-warning"); }
  };

  const handleUrlDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const data = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (data && /^https?:\/\/[^\s]+$/i.test(data.trim())) {
      const url = data.trim();
      // Enhancement 24: Auto-Fetching Metadata mock
      let title = url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40);
      let desc = "";
      let previewImg = "";
      try {
        const res = await fetch(`https://api.microlink.io?url=${encodeURIComponent(url)}`).catch(() => null);
        if (res && res.ok) {
           const json = await res.json();
           if (json.data?.title) title = json.data.title;
           if (json.data?.description) desc = json.data.description;
           if (json.data?.image?.url) previewImg = json.data.image.url;
        }
      } catch {
        // Metadata fetch is best-effort enrichment; fall back to the raw URL.
      }

      const r = await modal.form({ panel: true,
        title: "Add bookmark", icon: "ph-bookmark-simple", accent: "var(--h-bookmarks)", submitLabel: "Add bookmark",
        fields: [
          { name: "title", label: "Title", defaultValue: title, required: true },
          { name: "url", label: "URL", type: "url", defaultValue: url, required: true },
        ],
      });
      if (!r) return;
      try {
        await create(r.title, { url: r.url, createdAt: new Date().toISOString(), tags: [], desc, previewImg });
        toast("Bookmark added", "ph-bookmark");
      } catch (err) {
        console.error("Failed to create bookmark:", err);
      }
    }
  };

  useEffect(() => {
    const handleGlobalDrop = async (e: Event) => {
      const customEvent = e as CustomEvent;
      const paths = customEvent.detail?.paths;
      if (!paths || paths.length === 0) return;

      for (const p of paths) {
        const ext = p.split(".").pop()?.toLowerCase() || "";
        if (ext === "url" || ext === "webloc" || ext === "txt" || ext === "md") {
          try {
            const content = await fsReadNoteContent(p);
            let url = "";
            let title = p.split(/[\/\\]/).pop()?.replace(/\.[^/.]+$/, "") || "New Bookmark";

            if (ext === "url") {
              const match = content.match(/URL=(https?:\/\/[^\s\r\n]+)/i);
              if (match) url = match[1];
            } else if (ext === "webloc") {
              const match = content.match(/<string>(https?:\/\/[^\s\r\n<]+)<\/string>/i);
              if (match) url = match[1];
            } else {
              const match = content.match(/(https?:\/\/[^\s\r\n\)\"\'\>]+)/i);
              if (match) url = match[1];
            }

            if (url) {
              const r = await modal.form({ panel: true,
                title: "Add bookmark", icon: "ph-bookmark-simple", accent: "var(--h-bookmarks)", submitLabel: "Add bookmark",
                fields: [
                  { name: "title", label: "Title", defaultValue: title, required: true },
                  { name: "url", label: "URL", type: "url", defaultValue: url, required: true },
                ],
              });
              if (!r) continue;
              await create(r.title, { url: r.url, createdAt: new Date().toISOString(), tags: [] });
              toast("Bookmark added", "ph-bookmark");
            } else {
              toast(`No URL found inside ${title}.${ext}`, "ph-warning");
            }
          } catch (err) {
            console.error(err);
            toast(`Failed to read or parse shortcut: ${p}`, "ph-warning");
          }
        } else {
          toast(`Unsupported shortcut format: .${ext}`, "ph-warning");
        }
      }
    };

    window.addEventListener("loom-file-drop", handleGlobalDrop);
    return () => {
      window.removeEventListener("loom-file-drop", handleGlobalDrop);
    };
  }, [create, modal, toast]);

  const handleAdd = async () => {
    const r = await modal.form({ panel: true,
      title: "Add bookmark", icon: "ph-bookmark-simple", accent: "var(--h-bookmarks)", submitLabel: "Add bookmark",
      fields: [
        { name: "title", label: "Title", placeholder: "Bookmark name…", required: true },
        { name: "url", label: "URL", type: "url", defaultValue: "https://", placeholder: "https://…", required: true },
      ],
    });
    if (!r) return;
    try {
      await create(r.title, { url: r.url, createdAt: new Date().toISOString(), tags: [] });
      toast("Bookmark added", "ph-bookmark");
    } catch (err) {
      console.error("Failed to create bookmark:", err);
    }
  };

  const handleEdit = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getBookmarkMeta(item);
    const r = await modal.form({ panel: true,
      title: "Edit bookmark", icon: "ph-pencil", accent: "var(--h-bookmarks)", submitLabel: "Save changes",
      fields: [
        { name: "title", label: "Title", defaultValue: item.title, required: true },
        { name: "url", label: "URL", type: "url", defaultValue: meta.url, required: true },
      ],
    });
    if (!r) return;
    try {
      if (r.title !== item.title) await updateFields(item.id, r.title, "bookmark");
      if (r.url !== meta.url) await updateMeta(item.id, { ...meta, url: r.url });
      toast("Bookmark updated", "ph-pencil");
    } catch (err) {
      console.error("Failed to update bookmark:", err);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation();
    const ok = await modal.confirm({ title: "Delete bookmark", message: `Delete “${title}”? This cannot be undone.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try { await remove(id); toast("Bookmark deleted", "ph-trash"); }
    catch (err) { console.error("Failed to delete bookmark:", err); }
  };

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-bookmarks)" } as any}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleUrlDrop}
    >
      <PageHead mod="var(--h-bookmarks)" icon="ph-bookmark-simple" kicker="Bookmarks" title="Saved for reference"
        sub={`${items.length} saved · web links and in-app items`}>
        <div className="seg">
          <button className={cx(kind === "all" && "on")} onClick={() => setKind("all")}>All</button>
          <button className={cx(kind === "web" && "on")} onClick={() => setKind("web")}>Web</button>
          <button className={cx(kind === "app" && "on")} onClick={() => setKind("app")}>In-app</button>
        </div>
        <button className="btn outline" onClick={handleWebClipper}>
          <I n="ph-scissors" /> Web Clipper
        </button>
        <button className="btn primary" onClick={handleAdd}><I n="ph-plus" w="bold" /> Add bookmark</button>
      </PageHead>
      <div className="vault-grid">
        {loading ? (
          <div className="muted" style={{ padding: "20px 0" }}>Loading bookmarks...</div>
        ) : items.length === 0 ? (
          <EmptyState icon="ph-bookmark-simple" mod="var(--h-bookmarks)" title="No bookmarks yet" sub="Save a web link here, or bookmark any note, task, or item from its Connections panel.">
            <button className="btn primary sm" style={{ marginTop: 12 }} onClick={handleAdd}><I n="ph-plus" w="bold" /> Add bookmark</button>
          </EmptyState>
        ) : cards.map(({ item: b, meta, isInternal, target, mod }) => {
          // In-app bookmark → jump straight to the bookmarked thing. Web → its page.
          const onOpen = () => (isInternal && meta.targetId ? inspect(meta.targetId) : inspect(b.id));
          return (
            <div key={b.id} className="vault-card" style={{ "--mod": mod, position: "relative" } as any} onClick={onOpen} {...clickable(onOpen)}>
              <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4, zIndex: 10 }}>
                {!isInternal && meta.url && (
                  <>
                    <button className="btn icon sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: 4 }} onClick={(e) => { e.stopPropagation(); setReaderUrl(meta.url); }} title="Reader View">
                      <I n="ph-book-open" style={{ color: "var(--text-faint)" }} />
                    </button>
                    <button className="btn icon sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: 4 }} onClick={(e) => handleOpenUrl(e, meta.url)} title="Open in browser">
                      <I n="ph-arrow-square-out" style={{ color: "var(--text-faint)" }} />
                    </button>
                  </>
                )}
                {!isInternal && (
                  <button className="btn icon sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: 4 }} onClick={(e) => handleEdit(e, b)} title="Edit">
                    <I n="ph-pencil" style={{ color: "var(--text-faint)" }} />
                  </button>
                )}
                <button className="btn icon sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: 4 }} onClick={(e) => handleDelete(e, b.id, b.title)} title="Delete">
                  <I n="ph-trash" style={{ color: "var(--text-faint)" }} />
                </button>
              </div>
              <div className="vault-ico">
                <I n={isInternal ? (target?.icon || TYPE_ICON[meta.targetType || ""] || "ph-bookmark-simple") : "ph-bookmark-simple"} w="fill" />
              </div>
              <div className="vault-main" style={{ paddingRight: 60 }}>
                <div className="vault-t">{b.title}</div>
                <div className="vault-s" style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                  {isInternal
                    ? <span><I n="ph-arrow-bend-up-right" /> {TYPE_LABEL[meta.targetType || target?.type || ""] || "Item"} in LOOM{target ? ` · ${target.title}` : " · (deleted)"}</span>
                    : <a href={meta.url} onClick={(e) => { e.preventDefault(); handleOpenUrl(e, meta.url); }}>{meta.url}</a>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {readerUrl && <ReaderView url={readerUrl} onClose={() => setReaderUrl(null)} onClip={clipArticle} />}
    </div>
  );
}

// ---- FILES ----
const EXT_ICON: Record<string, string> = {
  PDF: "ph-file-pdf", DOC: "ph-file-doc", DOCX: "ph-file-doc", TEX: "ph-file-doc", MD: "ph-file-text",
  CSV: "ph-table", PARQ: "ph-table", XLSX: "ph-table", SH: "ph-terminal-window",
  PNG: "ph-image", JPG: "ph-image", ASE: "ph-image", ZIP: "ph-file-zip",
};
const iconForExt = (ext: string) => EXT_ICON[(ext || "").toUpperCase()] || "ph-file";

export function FilesModule() {
  const { inspect, toast } = useLoom();
  const modal = useModal();
  const { items, create, updateFields, remove, ready, importFile, openFile, revealInExplorer, workspaceId } = useFiles();
  const { refresh } = useItemStore();
  const [sort, setSort] = useState<{ key: "name" | "type" | "size" | "modified"; dir: 1 | -1 }>({ key: "modified", dir: -1 });
  // Read-model: sorted file rows + folder chips — in the VM.
  const { rows: list, folders } = useMemo(
    () => createFilesViewModel({ files: items }, { sortKey: sort.key, sortDir: sort.dir }),
    [items, sort],
  );
  const toggleSort = (key: "name" | "type" | "size" | "modified") => setSort((s) => s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 });
  const sortArrow = (key: string) => sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : "";

  useEffect(() => {
    const handleGlobalDrop = async (e: Event) => {
      const customEvent = e as CustomEvent;
      const paths = customEvent.detail?.paths;
      if (!paths || paths.length === 0) return;

      for (const p of paths) {
        const filename = p.split(/[\/\\]/).pop() || "file";
        const isCopy = await modal.confirm({
          title: "Import Strategy",
          message: `File: ${filename}\n\nCopy file into Loom or keep it where it is?`,
          icon: "ph-copy",
          confirmLabel: "Copy to Loom",
          cancelLabel: "Keep Reference"
        });
        const strat = isCopy ? "copy" : "reference";
        try {
          await importFile(p, strat);
          toast("File imported", "ph-check");
        } catch (err: any) {
          modal.confirm({ title: "Import Error", message: String(err), icon: "ph-warning", danger: true });
        }
      }
    };

    window.addEventListener("loom-file-drop", handleGlobalDrop);
    return () => {
      window.removeEventListener("loom-file-drop", handleGlobalDrop);
    };
  }, [importFile, modal, toast]);

  const handleNew = async () => {
    const r = await modal.form({ panel: true,
      title: "New file entry", icon: "ph-file-plus", accent: "var(--h-files)", submitLabel: "Create file",
      fields: [
        { name: "title", label: "File name", placeholder: "e.g. notes.txt", required: true },
        { name: "ext", label: "Type / extension", placeholder: "txt, md…" },
        { name: "folder", label: "Folder", defaultValue: "Unfiled" },
      ],
    });
    if (!r) return;
    const ext = (r.ext || (r.title.includes(".") ? r.title.split(".").pop()! : "txt")).toLowerCase();
    const folder = r.folder || "Unfiled";
    try {
      await create(r.title, { folder, ext });
      toast("File created on disk", "ph-file-plus");
    } catch (err: any) { 
      console.error("Failed to create file:", err); 
      modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleRename = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const r = await modal.form({ panel: true,
      title: "Rename file", icon: "ph-pencil", accent: "var(--h-files)", submitLabel: "Rename",
      fields: [{ name: "title", label: "New Name (without extension)", defaultValue: item.title, required: true }],
    });
    if (!r) return;
    try { await updateFields(item.id, r.title); toast("File renamed", "ph-pencil"); }
    catch (err: any) { 
      console.error("Failed to rename file:", err);
      modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation();
    const ok = await modal.confirm({ title: "Delete file", message: `Delete “${title}”? This will remove the file from the filesystem if it was copied to Loom.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try { await remove(id); toast("File deleted", "ph-trash"); }
    catch (err: any) { 
      console.error("Failed to delete file:", err);
      modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleReveal = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    try { await revealInExplorer(path); }
    catch (err: any) { console.error("Failed to reveal:", err); }
  };

  const [previewMedia, setPreviewMedia] = useState<{ path: string; ext: string } | null>(null);

  const handleOpen = async (e: React.MouseEvent | null, path: string, ext: string) => {
    e?.stopPropagation();
    const lowerExt = ext.toLowerCase();
    // In-app preview for common media/text; everything else opens in the OS handler.
    if (PREVIEWABLE_EXTS.includes(lowerExt)) {
      setPreviewMedia({ path, ext: lowerExt });
    } else {
      try { await openFile(path); }
      catch (err: any) { 
        console.error("Failed to open:", err);
        modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
      }
    }
  };

  // Real file-at-rest encryption (AES-256-GCM, Argon2 key). Encrypts in place to .enc
  // and removes the plaintext; decrypt reverses it. Path changes, so we refresh after.
  const handleEncrypt = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getFileMeta(item);
    const isEnc = meta.path.toLowerCase().endsWith(".enc");

    if (isEnc) {
      const r = await modal.form({ panel: true,
        title: "Decrypt file", icon: "ph-lock-open", accent: "var(--h-files)", submitLabel: "Decrypt",
        fields: [{ name: "password", label: "Password", type: "password", required: true }],
      });
      if (!r) return;
      try {
        await decryptFile(item.id, r.password);
        await refresh();
        toast("File decrypted", "ph-lock-open");
      } catch (err: any) {
        modal.confirm({ title: "Decryption failed", message: String(err), icon: "ph-warning", danger: true, confirmLabel: "OK" });
      }
      return;
    }

    const r = await modal.form({ panel: true,
      title: "Encrypt file", icon: "ph-lock", accent: "var(--h-files)", submitLabel: "Encrypt",
      fields: [
        { name: "password", label: "Password", type: "password", required: true, placeholder: "Choose a strong password" },
        { name: "confirm", label: "Confirm password", type: "password", required: true },
      ],
    });
    if (!r) return;
    if (r.password !== r.confirm) {
      modal.confirm({ title: "Passwords don't match", message: "The two passwords are different. Nothing was changed.", icon: "ph-warning", danger: true, confirmLabel: "OK" });
      return;
    }
    try {
      await encryptFile(item.id, r.password);
      await refresh();
      toast("File encrypted (AES-256-GCM)", "ph-lock-key");
    } catch (err: any) {
      modal.confirm({ title: "Encryption failed", message: String(err), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    }
  };

  // Full-text index of text-based files into the search/DB pipeline (not OCR).
  const handleIndexText = async () => {
    if (!workspaceId) return;
    try {
      const res = await indexTextFiles(workspaceId);
      await refresh();
      toast(`Indexed ${res.indexed} of ${res.total} files (${res.skipped} skipped)`, "ph-text-aa");
    } catch (err: any) {
      modal.confirm({ title: "Indexing failed", message: String(err), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    }
  };

  const COLS = "1fr 90px 80px 110px 184px";
  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-files)" } as any}>
      <PageHead mod="var(--h-files)" icon="ph-folder" kicker="Files" title="Everything you've attached"
        sub={`${list.length} files · ${folders.length} folders`}>
        <AsyncButton className="btn outline" onClick={handleIndexText} icon="ph-text-aa" loadingLabel="Indexing…" title="Index text-based files so search can match their contents">Index Text</AsyncButton>
        <button className="btn primary" onClick={handleNew}><I n="ph-file-plus" w="bold" /> New file</button>
      </PageHead>
      <div className="row wrap gap12" style={{ marginBottom: 22 }}>
        {folders.map((f) => (
          <div key={f} className="chip" style={{ "--mod": "var(--h-files)", height: 40, padding: "0 16px", borderRadius: "var(--r-md)" } as any}>
            <I n="ph-folder" w="fill" style={{ color: "var(--h-files)", fontSize: "var(--fs-2xl)" }} /> <span style={{ fontWeight: 550 }}>{f}</span>
            <span className="mono-sm ghost">{list.filter(({ meta }) => meta.folder.startsWith(f)).length}</span>
          </div>
        ))}
      </div>
      {!ready ? (
        <div className="muted" style={{ padding: "20px 0" }}>Loading files...</div>
      ) : list.length === 0 ? (
        <EmptyState icon="ph-folder" mod="var(--h-files)" title="No files yet" sub="Drag and drop files here, or create a new one.">
          <button className="btn primary sm" style={{ marginTop: 12 }} onClick={handleNew}><I n="ph-file-plus" w="bold" /> New file</button>
        </EmptyState>
      ) : (
      <div style={{ background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: COLS, padding: "10px 16px", borderBottom: "1px solid var(--border)" }} className="mono-sm ghost">
          <button className="file-sort" onClick={() => toggleSort("name")}>NAME{sortArrow("name")}</button>
          <button className="file-sort" onClick={() => toggleSort("type")}>TYPE{sortArrow("type")}</button>
          <button className="file-sort" onClick={() => toggleSort("size")}>SIZE{sortArrow("size")}</button>
          <button className="file-sort" onClick={() => toggleSort("modified")}>MODIFIED{sortArrow("modified")}</button>
          <span style={{ textAlign: "right" }}></span>
        </div>
        {list.map(({ item, meta }) => (
          <div key={item.id} className="wrow" style={{ "--mod": meta.color, display: "grid", gridTemplateColumns: COLS, margin: 0, padding: "11px 16px", borderRadius: 0, borderTop: "1px solid var(--border-faint)", alignItems: "center" } as any}>
            {/* The open affordance is the name cell only — a discrete target so it can
                never be hit by a near-miss on the action buttons (those live in their
                own grid cell, a sibling, so their clicks never reach this handler). */}
            <div className="row gap12" style={{ minWidth: 0, cursor: "pointer" }}
                 title={`Open ${item.title}`}
                 onClick={() => handleOpen(null, meta.path, meta.ext)}
                 {...clickable(() => handleOpen(null, meta.path, meta.ext))}>
              <div className="wrow-ico" style={{ width: 28, height: 28, flex: "0 0 28px", fontSize: "var(--fs-base)" }}><I n={iconForExt(meta.ext)} /></div>
              <div style={{ minWidth: 0 }}>
                <div className="wrow-t">{item.title}</div>
                <div className="wrow-s" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta.path}</div>
              </div>
            </div>
            <span className="mono-sm muted">{meta.ext}</span>
            <span className="mono-sm muted">{meta.size}</span>
            <span className="mono-sm ghost">{meta.updated}</span>
            <div className="row gap8" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn icon sm" style={{ padding: 7 }} onClick={(e) => handleEncrypt(e, item)} title={meta.path.toLowerCase().endsWith(".enc") ? "Decrypt" : "Encrypt"}>
                <I n={meta.path.toLowerCase().endsWith(".enc") ? "ph-lock-key" : "ph-lock"} style={{ color: meta.path.toLowerCase().endsWith(".enc") ? "var(--h-vault)" : "var(--text-faint)" }} />
              </button>
              <button type="button" className="btn icon sm" style={{ padding: 7 }} onClick={(e) => { e.stopPropagation(); inspect(item.id); }} title="Details">
                <I n="ph-magnifying-glass" style={{ color: "var(--text-faint)" }} />
              </button>
              <button type="button" className="btn icon sm" style={{ padding: 7 }} onClick={(e) => handleReveal(e, meta.path)} title="Reveal in Explorer">
                <I n="ph-folder-open" style={{ color: "var(--text-faint)" }} />
              </button>
              <button type="button" className="btn icon sm" style={{ padding: 7 }} onClick={(e) => handleRename(e, item)} title="Rename">
                <I n="ph-pencil" style={{ color: "var(--text-faint)" }} />
              </button>
              <button type="button" className="btn icon sm" style={{ padding: 7 }} onClick={(e) => handleDelete(e, item.id, item.title)} title="Delete">
                <I n="ph-trash" style={{ color: "var(--text-faint)" }} />
              </button>
            </div>
          </div>
        ))}
      </div>
      )}
      {previewMedia && (
        <FilePreview
          media={previewMedia}
          onClose={() => setPreviewMedia(null)}
          onOpenExternal={() => { const p = previewMedia.path; setPreviewMedia(null); openFile(p).catch(() => {}); }}
        />
      )}
    </div>
  );
}

// Common previewable formats. Anything outside these opens in the OS handler instead.
const PREVIEW_IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];
const PREVIEW_VIDEO = ["mp4", "webm", "ogg", "mov", "mkv"];
const PREVIEW_AUDIO = ["mp3", "wav", "flac", "m4a", "aac"];
const PREVIEW_TEXT = ["md", "markdown", "txt", "csv", "log", "json", "xml", "yml", "yaml"];
export const PREVIEWABLE_EXTS = [...PREVIEW_IMAGE, ...PREVIEW_VIDEO, ...PREVIEW_AUDIO, ...PREVIEW_TEXT];

// In-app file preview. Media is served through Tauri's asset protocol via
// convertFileSrc (the dev-server URL the old code used does not exist in a packaged
// build). Text is read over IPC. Anything that fails to load degrades to a clear
// fallback with an "open externally" escape hatch — never a broken-image glyph.
function FilePreview({ media, onClose, onOpenExternal }: {
  media: { path: string; ext: string };
  onClose: () => void;
  onOpenExternal: () => void;
}) {
  const { path, ext } = media;
  const src = convertFileSrc(path);
  const isImage = PREVIEW_IMAGE.includes(ext);
  const isVideo = PREVIEW_VIDEO.includes(ext);
  const isAudio = PREVIEW_AUDIO.includes(ext);
  const isText = PREVIEW_TEXT.includes(ext);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isText) return;
    let alive = true;
    fsReadNoteContent(path).then((c) => alive && setText(c)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [path, isText]);

  const name = path.split(/[\/\\]/).pop() || path;
  const Fallback = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "50px 60px", textAlign: "center" }}>
      <I n="ph-file-dashed" style={{ fontSize: 48, color: "var(--text-faint)" }} />
      <div className="muted">No in-app preview for <strong>{name}</strong>.</div>
      <button className="btn primary sm" onClick={onOpenExternal}><I n="ph-arrow-square-out" w="bold" /> Open externally</button>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }} onClick={onClose}>
      <button className="btn icon" style={{ position: "absolute", top: 20, right: 20, background: "rgba(255,255,255,0.1)", color: "#fff" }} onClick={onClose}><I n="ph-x" /></button>
      <div style={{ maxWidth: "90vw", maxHeight: "90vh", overflow: "auto", background: "var(--surface-1)", borderRadius: "var(--r-lg)", padding: 20, boxShadow: "0 10px 40px rgba(0,0,0,0.5)" }} onClick={(e) => e.stopPropagation()}>
        {isImage && (failed
          ? Fallback
          : <img src={src} onError={() => setFailed(true)} style={{ maxWidth: "82vw", maxHeight: "80vh", objectFit: "contain", display: "block" }} alt={name} />)}
        {isVideo && <video src={src} controls autoPlay onError={() => setFailed(true)} style={{ maxWidth: "82vw", maxHeight: "80vh", display: "block" }} />}
        {isAudio && <audio src={src} controls autoPlay onError={() => setFailed(true)} />}
        {isText && (failed
          ? Fallback
          : text === null
            ? <div className="muted" style={{ padding: 40 }}>Loading preview…</div>
            : <pre style={{ maxWidth: "82vw", maxHeight: "80vh", overflow: "auto", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)", lineHeight: 1.6 }}>{text}</pre>)}
        {!isImage && !isVideo && !isAudio && !isText && Fallback}
      </div>
    </div>
  );
}

