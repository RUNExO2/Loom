import React, { useMemo } from "react";
import { I, useLoom } from "../../lib/context";
import { Item } from "../../ipc/items";
import { useHabits, useItemStore } from "../../lib/itemStore";
import { getHabitMeta } from "../../lib/meta";
import { createHabitsViewModel } from "../../lib/viewmodels";
import { deleteCommand, useCommands } from "../../lib/commands";
import { useModal } from "../Modal";
import { EmptyState } from "../shared";
import { buildHeatmap, toggleLogDate } from "../../lib/heatmap";
import { PageHead } from "./shared";

export function HabitsModule() {
  const { toast } = useLoom();
  const modal = useModal();
  const commands = useCommands();
  const { items, create, updateMeta, updateFields, remove, restore, ready } = useHabits();
  const { links } = useItemStore();
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
      await updateMeta(item.id, { ...meta, goal: r.goal || "Daily", duration: parseInt(r.duration, 10) || meta.duration });
      toast("Habit updated", "ph-check-circle");
    } catch (err) { console.error("Failed to edit habit:", err); }
  };

  const toggleToday = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getHabitMeta(item);
    const week = [...meta.week];
    const today = week.length - 1;
    const nowOn = !week[today];
    week[today] = nowOn ? 1 : 0;
    const streak = Math.max(0, meta.streak + (nowOn ? 1 : -1));
    const bestStreak = Math.max(meta.bestStreak, streak);
    const totalDone = Math.max(0, (meta.totalDone || 0) + (nowOn ? 1 : -1));
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
    const ok = await modal.confirm({ title: "Delete habit", message: `Delete "${item.title}"? You can undo right after.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
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
        {list.map(({ item, meta, doneToday, pct, daysLeft }) => (
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
                <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: `repeat(${Math.min(meta.duration, 15)}, 1fr)`, gap: 4 }}>
                  {Array.from({ length: meta.duration }).map((_, i) => {
                    const isDone = i >= meta.duration - meta.streak;
                    return (
                      <div key={i} style={{ height: 14, borderRadius: 3, background: isDone ? meta.color : "var(--surface-3)" }} title={isDone ? `Day ${i + 1} · completed` : `Day ${i + 1}`}></div>
                    );
                  })}
                </div>
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
                <button className={`btn sm${doneToday ? " primary" : ""}`} disabled={meta.paused} onClick={(e) => toggleToday(e, item)} title={meta.paused ? "Resume to check in" : "Toggle today"}>
                  <I n="ph-check" w="bold" /> {doneToday ? "Done" : "Today"}
                </button>
                <button className={`btn icon sm${meta.paused ? " active" : ""}`} onClick={(e) => togglePause(e, item)} title={meta.paused ? "Resume habit" : "Pause habit (freeze streak)"}>
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
        ))}
      </div>
      )}
    </div>
  );
}
