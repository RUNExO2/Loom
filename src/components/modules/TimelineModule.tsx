import { useMemo } from "react";
import { I, cx, useLoom, clickable } from "../../lib/context";
import { EmptyState } from "../shared";
import { useItemStore } from "../../lib/itemStore";
import { useViewMemory } from "../../lib/viewMemory";
import { TIMELINE_KINDS } from "../../lib/timeline";
import { createTimelineViewModel } from "../../lib/viewmodels";
import { PageHead } from "./shared";

export function TimelineModule() {
  const { inspect } = useLoom();
  const { items } = useItemStore();
  const [filter, setFilter] = useViewMemory("timeline.filter", "all");
  const [tq, setTq] = useViewMemory("timeline.query", "");
  const kinds = TIMELINE_KINDS;

  // Read-model: timeline projection + kind/search filter + month grouping — all in the VM.
  const { events, months } = useMemo(
    () => createTimelineViewModel({ items, links: [] }, filter, tq),
    [items, filter, tq],
  );

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-timeline)" } as any}>
      <PageHead mod="var(--h-timeline)" icon="ph-clock-counter-clockwise" kicker="Timeline" title="Your life-stream"
        sub="Every note, task, project, book, event, habit, file, and bookmark — one scrollable history." />

      <div className="search-inline" style={{ marginBottom: 14, maxWidth: 420 }}>
        <I n="ph-magnifying-glass" /><input placeholder="Search your history…" value={tq} onChange={(e) => setTq(e.target.value)} />
        {tq && <button className="btn icon sm" onClick={() => setTq("")} aria-label="Clear search"><I n="ph-x" /></button>}
      </div>
      <div className="row wrap gap6" style={{ marginBottom: 22 }}>
        {kinds.map(([k, l, ic]) => (
          <button key={k} className={cx("chip", filter === k && "active")}
            style={filter === k ? { background: "var(--accent-soft)", color: "var(--accent-text)", borderColor: "var(--accent-line)" } : {}}
            onClick={() => setFilter(k)}>
            <I n={ic} /> {l}
          </button>
        ))}
      </div>

      {events.length === 0 ? (
        <EmptyState icon="ph-clock-counter-clockwise" mod="var(--h-timeline)" title="No activity yet" sub="Create anything and it lands here." />
      ) : (
      <div className="timeline-wrap">
        <div className="tl-spine"></div>
        {months.map((m) => (
          <div className="tl-month" key={m.month}>
            <div className="tl-month-label">
              <span className="m">{m.month.split(" ")[0]}</span>
              <span className="y">{m.month.split(" ")[1]}</span>
              <span className="ct">{m.events.length} events</span>
            </div>
            {m.events.map((e) => (
              <div className="tl-event" key={e.id} style={{ "--mod": e.color } as any}>
                <div className="tl-when">{e.when}</div>
                <div className="tl-node fill"></div>
                <div className="tl-body">
                  <div className="tl-card" onClick={() => inspect(e.id)} {...clickable(() => inspect(e.id))}>
                    <div className="tl-card-head">
                      <span className="tl-kind"><I n={e.icon} w="fill" /> {e.kind}</span>
                    </div>
                    <div className="tl-card-t">{e.title}</div>
                    <div className="tl-card-s">{e.sub}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
