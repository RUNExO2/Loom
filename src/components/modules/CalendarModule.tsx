import React, { useState, useEffect, useMemo, useCallback } from "react";
import { I, cx, useLoom, clickable } from "../../lib/context";
import { useCalendar, useItemStore, useTasks } from "../../lib/itemStore";
import { getCalendarMeta } from "../../lib/meta";
import { createCalendarViewModel, calSameDate } from "../../lib/viewmodels";
import { useModal } from "../Modal";
import { EmptyState } from "../shared";
import { fsWriteAnyFile } from "../../ipc/fs";
import { save } from "@tauri-apps/plugin-dialog";
import { AsyncButton } from "../ui/AsyncButton";
import { PageHead } from "./shared";

function toLocalInput(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

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

export function CalendarModule() {
  const { inspect, toast } = useLoom();
  const modal = useModal();
  const { items, create, remove, ready } = useCalendar();
  const { links } = useItemStore();
  const loading = !ready;
  const [view, setView] = useState<"day" | "week" | "month" | "agenda">("week");
  const [anchor, setAnchor] = useState<Date>(() => new Date());

  const { items: allTasks } = useTasks();
  const vm = useMemo(
    () => createCalendarViewModel({ calendar: items, links, tasks: allTasks }, { view, now: anchor }),
    [items, links, allTasks, view, anchor],
  );
  const { today, todayCol, weekDates, weekBlocks, dayBlocks, monthCells, agenda, unscheduledTasks, eventsOn } = vm;
  const realToday = new Date();

  const shift = useCallback((dir: number) => setAnchor((a) => {
    const d = new Date(a);
    if (view === "day") d.setDate(d.getDate() + dir);
    else if (view === "month") d.setMonth(d.getMonth() + dir);
    else d.setDate(d.getDate() + 7 * dir);
    return d;
  }), [view]);
  const goToday = useCallback(() => setAnchor(new Date()), []);

  const inCurrentPeriod = view === "month"
    ? anchor.getMonth() === realToday.getMonth() && anchor.getFullYear() === realToday.getFullYear()
    : view === "day"
      ? calSameDate(anchor, realToday)
      : weekDates.some((d) => calSameDate(d, realToday));
  const headerTitle = (view === "month"
    ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : view === "day"
      ? anchor.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
      : view === "agenda"
        ? "Agenda"
        : `Week of ${weekDates[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })}`)
    + (inCurrentPeriod && view !== "agenda" ? (view === "day" ? " · Today" : " · This week") : "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /input|textarea|select/i.test(t.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.key === "ArrowLeft") shift(-1);
      else if (e.key === "ArrowRight") shift(1);
      else if (k === "t") goToday();
      else if (k === "d") setView("day");
      else if (k === "w") setView("week");
      else if (k === "m") setView("month");
      else if (k === "a") setView("agenda");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shift, goToday]);

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
    const startDate = new Date(r.start);
    if (isNaN(startDate.getTime())) return;
    const endDate = new Date(startDate.getTime() + 3600000);
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
    const ok = await modal.confirm({ title: "Delete event", message: `Delete "${title}"? This cannot be undone.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try { await remove(id); toast("Event deleted", "ph-trash"); }
    catch (err) { console.error("Failed to delete event:", err); }
  };

  const [unscheduleHot, setUnscheduleHot] = useState(false);
  const handleUnschedule = async (e: React.DragEvent) => {
    e.preventDefault();
    setUnscheduleHot(false);
    const eventId = e.dataTransfer.getData("application/x-loom-event");
    if (!eventId) return;
    const ev = items.find((it) => it.id === eventId);
    try {
      await remove(eventId);
      toast(`Unscheduled${ev ? ` "${ev.title}"` : ""}`, "ph-calendar-x");
    } catch (err) { console.error("Failed to unschedule:", err); }
  };

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-calendar)" } as any}>
      <PageHead mod="var(--h-calendar)" icon="ph-calendar-dots" kicker="Calendar" title={headerTitle}
        sub="Time-blocked schedule. Events link to the tasks, projects, and media behind them.">
        {view !== "agenda" && (
          <div className="seg" title="←/→ to navigate · T for today">
            <button onClick={() => shift(-1)} title="Previous (←)"><I n="ph-caret-left" /></button>
            <button onClick={goToday} title="Today (T)">Today</button>
            <button onClick={() => shift(1)} title="Next (→)"><I n="ph-caret-right" /></button>
          </div>
        )}
        <div className="seg">
          <button className={cx(view === "day" && "on")} onClick={() => setView("day")} title="Day (D)">Day</button>
          <button className={cx(view === "week" && "on")} onClick={() => setView("week")} title="Week (W)">Week</button>
          <button className={cx(view === "month" && "on")} onClick={() => setView("month")} title="Month (M)">Month</button>
          <button className={cx(view === "agenda" && "on")} onClick={() => setView("agenda")} title="Agenda (A)">Agenda</button>
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
                const isToday = sameDate(weekDates[i], realToday);
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
                <div key={di} style={{ borderLeft: "1px solid var(--border-faint)", position: "relative", background: weekDates[di] && sameDate(weekDates[di], realToday) ? "color-mix(in oklch, var(--accent) 4%, transparent)" : "transparent" }}>
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
                <div key={i} style={{ minHeight: 84, borderRadius: "var(--r-md)", border: d ? "1px solid var(--border-faint)" : "none", padding: d ? 6 : 0, background: d && sameDate(d, realToday) ? "var(--accent-soft)" : d ? "var(--surface-2)" : "transparent" }}>
                  {d && (
                    <>
                      <div style={{ fontSize: "var(--fs-sm)", fontWeight: 600, marginBottom: 4, color: sameDate(d, realToday) ? "var(--accent-text)" : "var(--text-faint)" }}>{d.getDate()}</div>
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
