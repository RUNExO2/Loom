import React, { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { listStagger, listItem } from "../../lib/motionVariants";
import { I, cx, useLoom, clickable } from "../../lib/context";
import { Item } from "../../ipc/items";
import { useTasks, useItemStore } from "../../lib/itemStore";
import { getTaskMeta, dueInfo, Subtask } from "../../lib/meta";
import { createTasksViewModel } from "../../lib/viewmodels";
import { deleteCommand, useCommands } from "../../lib/commands";
import { useModal } from "../Modal";
import { EmptyState } from "../shared";
import { useViewMemory } from "../../lib/viewMemory";
import { parseRecurrence, Recurrence } from "../../lib/recurrence";
import { PageHead } from "./shared";

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

export function TasksModule() {
  const { inspect, toast } = useLoom();
  const modal = useModal();
  const commands = useCommands();
  const { items: tasks, create, updateMeta, updateFields, remove, restore, ready } = useTasks();
  const { links, items: allItems } = useItemStore();
  const loading = !ready;
  const [group, setGroup] = useViewMemory("tasks.group", "due");
  const [prio, setPrio] = useViewMemory("tasks.prio", "all");

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
    } catch (err) { console.error("Failed to toggle task done status:", err); }
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

    let finalDate = r.dueDate;
    const lowerTitle = r.title.toLowerCase();
    if (lowerTitle.includes("tomorrow")) {
      const tm = new Date(); tm.setDate(tm.getDate() + 1);
      finalDate = tm.toISOString().split("T")[0];
    } else if (lowerTitle.includes("next week")) {
      const nw = new Date(); nw.setDate(nw.getDate() + 7);
      finalDate = nw.toISOString().split("T")[0];
    }
    const cleanTitle = r.title.replace(/tomorrow/i, "").replace(/next week/i, "").trim();

    try {
      await create(cleanTitle, { done: false, priority: r.priority, dueDate: finalDate, due: dueInfo(finalDate).label, recurrence: toRecurrence(r.recurrence), project: r.project || "Inbox", subtasks: [] });
      toast("Task created", "ph-check-circle");
    } catch (err) { console.error("Failed to create task in SQLite:", err); }
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
    const ok = await modal.confirm({ title: "Delete task", message: `Delete "${item.title}"? You can undo right after.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try {
      const itemLinks = links.filter((l) => l.source_id === item.id || l.target_id === item.id);
      await commands.run(deleteCommand(remove, restore, item, itemLinks, "Delete Task"));
      toast("Task deleted", "ph-trash", { label: "Undo", onClick: () => commands.undo() });
    } catch (err) { console.error("Failed to delete task:", err); }
  };

  const PRIO: Record<string, string> = { high: "var(--sys-danger)", med: "var(--sys-info)", low: "var(--text-faint)" };

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
