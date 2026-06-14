import { describe, it, expect } from "vitest";
import { Item } from "../ipc/items";
import { Link } from "../ipc/links";
import {
  greetingFor, contextCardFor, mediaProgressVM,
  createDashboardViewModel, createTimelineViewModel, createInboxViewModel,
  createTasksViewModel, createProjectsViewModel, createHabitsViewModel,
  createCalendarViewModel, createBookmarksViewModel, createFilesViewModel,
  createNotesViewModel, createLibraryViewModel, createVaultViewModel,
  createAutomationViewModel, filterExecutions, createGraphViewModel,
} from "./viewmodels";
import { LibraryMetadata } from "./meta";

function link(source_id: string, target_id: string): Link {
  return { source_id, target_id, relationship_type: "related" } as Link;
}

// Minimal SQLite-shaped row. created_at uses the "YYYY-MM-DD HH:MM:SS" form the
// backend emits; mid-day/mid-month keeps month math tz-stable.
function item(over: { item_type: string; title?: string; created_at?: string; metadata?: any }): Item {
  return {
    id: Math.random().toString(36).slice(2),
    workspace_id: "ws",
    item_type: over.item_type,
    title: over.title ?? "untitled",
    created_at: over.created_at ?? "2026-06-15 12:00:00",
    user_pinned: false,
    user_size_preference: null,
    metadata: typeof over.metadata === "string" ? over.metadata : JSON.stringify(over.metadata ?? {}),
  };
}

describe("time-of-day derivations", () => {
  it("greetingFor crosses at noon and 18:00", () => {
    expect(greetingFor(new Date(2026, 0, 1, 9))).toBe("Good morning");
    expect(greetingFor(new Date(2026, 0, 1, 11, 59))).toBe("Good morning");
    expect(greetingFor(new Date(2026, 0, 1, 12))).toBe("Good afternoon");
    expect(greetingFor(new Date(2026, 0, 1, 17, 59))).toBe("Good afternoon");
    expect(greetingFor(new Date(2026, 0, 1, 18))).toBe("Good evening");
    expect(greetingFor(new Date(2026, 0, 1, 23))).toBe("Good evening");
  });

  it("contextCardFor matches the greeting boundaries", () => {
    expect(contextCardFor(new Date(2026, 0, 1, 8)).title).toBe("Morning Agenda");
    expect(contextCardFor(new Date(2026, 0, 1, 14)).title).toBe("Afternoon Focus");
    expect(contextCardFor(new Date(2026, 0, 1, 21)).title).toBe("Evening Review");
  });
});

describe("mediaProgressVM", () => {
  const m = (current: number, total: number) => ({ progress: { current, total } } as LibraryMetadata);
  it("unknown total → 0% and bare count", () => {
    expect(mediaProgressVM(m(7, 0))).toEqual({ perc: 0, label: "7" });
  });
  it("known total → rounded % and fraction label", () => {
    expect(mediaProgressVM(m(5, 10))).toEqual({ perc: 50, label: "5 / 10" });
    expect(mediaProgressVM(m(1, 3))).toEqual({ perc: 33, label: "1 / 3" });
  });
  it("clamps overflow to 100%", () => {
    expect(mediaProgressVM(m(12, 10)).perc).toBe(100);
  });
});

describe("createDashboardViewModel", () => {
  const items: Item[] = [
    item({ item_type: "task", title: "T1", metadata: { done: false } }),
    item({ item_type: "task", title: "T2", metadata: { done: true } }),
    item({ item_type: "project", title: "P1", metadata: { status: "Active", progress: 40 } }),
    item({ item_type: "project", title: "P2", metadata: { status: "Archived" } }),
    item({ item_type: "note", title: "N1", metadata: { folder: "Inbox" } }),
    item({ item_type: "library", title: "Book", metadata: { mediaType: "book", status: "Reading", progress: { current: 2, total: 4 } } }),
    item({ item_type: "library", title: "Show", metadata: { mediaType: "tv", status: "Watching", progress: { current: 1, total: 0 } } }),
    item({ item_type: "habit", title: "H1", metadata: { streak: 3 } }),
  ];

  it("assembles each section from the right item_type", () => {
    const vm = createDashboardViewModel({ items, links: [] }, true);
    expect(vm.tasks).toHaveLength(2);
    expect(vm.projects.map((p) => p.item.title)).toEqual(["P1", "P2"]); // expanded → all
    expect(vm.notes[0].meta.folder).toBe("Inbox");
    expect(vm.reading).toHaveLength(1);
    expect(vm.reading[0].progress).toEqual({ perc: 50, label: "2 / 4" });
    expect(vm.watching).toHaveLength(1);
    expect(vm.watching[0].progress.label).toBe("1");
    expect(vm.habits).toHaveLength(1);
    expect(vm.stats.counts.total).toBe(items.length);
  });

  it("collapsed hides non-active projects, expanded shows them", () => {
    const collapsed = createDashboardViewModel({ items, links: [] }, false);
    expect(collapsed.projects.map((p) => p.item.title)).toEqual(["P1"]); // only Active
  });

  it("widgetCount is screen-owned (0 until the layout fills it)", () => {
    expect(createDashboardViewModel({ items, links: [] }).widgetCount).toBe(0);
  });

  it("greeting/context come from a fresh clock when provided", () => {
    const vm = createDashboardViewModel({ items, links: [], now: new Date(2026, 0, 1, 9) });
    expect(vm.greeting).toBe("Good morning");
    expect(vm.contextCard.title).toBe("Morning Agenda");
  });
});

describe("createTimelineViewModel", () => {
  const items: Item[] = [
    item({ item_type: "task", title: "June A", created_at: "2026-06-15 12:00:00" }),
    item({ item_type: "note", title: "June B", created_at: "2026-06-10 12:00:00" }),
    item({ item_type: "task", title: "May A", created_at: "2026-05-15 12:00:00" }),
  ];

  it("groups contiguous months newest-first", () => {
    const vm = createTimelineViewModel({ items, links: [] });
    expect(vm.count).toBe(3);
    expect(vm.months.map((m) => m.month)).toEqual(["June 2026", "May 2026"]);
    expect(vm.months[0].events).toHaveLength(2);
    expect(vm.months[1].events).toHaveLength(1);
  });

  it("filters by kind", () => {
    const vm = createTimelineViewModel({ items, links: [] }, "task");
    expect(vm.count).toBe(2);
    expect(vm.events.every((e) => e.kind === "task")).toBe(true);
  });

  it("filters by search query over title + sub", () => {
    const vm = createTimelineViewModel({ items, links: [] }, "all", "june a");
    expect(vm.events.map((e) => e.title)).toEqual(["June A"]);
    expect(createTimelineViewModel({ items, links: [] }, "all", "zzz").count).toBe(0);
  });
});

describe("createInboxViewModel", () => {
  it("finds inbox items by title/tag and reports emptiness", () => {
    const empty = createInboxViewModel({ items: [item({ item_type: "note", title: "hello" })], links: [] });
    expect(empty.empty).toBe(true);
    expect(empty.count).toBe(0);

    const vm = createInboxViewModel({
      items: [
        item({ item_type: "note", title: "My Inbox" }),
        item({ item_type: "task", title: "todo", metadata: { tags: ["inbox"] } }),
        item({ item_type: "note", title: "ignored" }),
      ],
      links: [],
    });
    expect(vm.count).toBe(2);
    expect(vm.empty).toBe(false);
  });
});

describe("createTasksViewModel", () => {
  const now = new Date(2026, 5, 15, 9, 0, 0); // Mon Jun 15 2026
  const iso = (offsetDays: number) => {
    const d = new Date(2026, 5, 15 + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const tasks: Item[] = [
    // Fixed past date so `overdue` (which dueInfo computes against the real today) holds
    // regardless of when the suite runs; bucketing still uses the injected `now`.
    item({ item_type: "task", title: "overdue", metadata: { done: false, priority: "high", dueDate: "2020-01-01", project: "A", subtasks: [{ id: "s1", text: "x", done: true }, { id: "s2", text: "y", done: false }] } }),
    item({ item_type: "task", title: "today", metadata: { done: false, priority: "low", dueDate: iso(0), project: "A" } }),
    item({ item_type: "task", title: "later", metadata: { done: false, priority: "med", dueDate: iso(20), project: "B" } }),
    item({ item_type: "task", title: "done", metadata: { done: true, priority: "med", dueDate: iso(0), project: "B" } }),
  ];

  it("derives rows, counts, and subtask progress", () => {
    const vm = createTasksViewModel({ tasks, links: [], allItems: tasks }, { group: "due", prio: "all", now });
    expect(vm.rows).toHaveLength(4);
    expect(vm.openCount).toBe(3);
    expect(vm.overdueCount).toBe(1);
    expect(vm.projectCount).toBe(2);
    const overdue = vm.rows.find((r) => r.title === "overdue")!;
    expect(overdue.overdue).toBe(true);
    expect(overdue.subDone).toBe(1);
    expect(overdue.subPct).toBe(50);
    expect(overdue.raw).toBe(tasks[0]);
  });

  it("buckets by due date and respects the priority filter", () => {
    const due = createTasksViewModel({ tasks, links: [], allItems: tasks }, { group: "due", prio: "all", now });
    const byLabel = Object.fromEntries(due.groups.map(([l, g]) => [l, g.map((t) => t.title)]));
    expect(byLabel["Overdue"]).toEqual(["overdue"]);
    expect(byLabel["Today"]).toEqual(["today"]);
    expect(byLabel["Later"]).toEqual(["later"]);
    expect(byLabel["Done"]).toEqual(["done"]);

    const high = createTasksViewModel({ tasks, links: [], allItems: tasks }, { group: "due", prio: "high", now });
    expect(high.visible.map((t) => t.title)).toEqual(["overdue"]);
  });

  it("kanban groups into Todo / Done", () => {
    const vm = createTasksViewModel({ tasks, links: [], allItems: tasks }, { group: "kanban", prio: "all", now });
    expect(vm.groups.map(([l]) => l)).toEqual(["Todo", "Done"]);
    expect(vm.groups[0][1]).toHaveLength(3);
    expect(vm.groups[1][1]).toHaveLength(1);
  });

  it("counts live links per row", () => {
    const vm = createTasksViewModel({ tasks, links: [link(tasks[0].id, tasks[1].id)], allItems: tasks }, { group: "due", prio: "all", now });
    expect(vm.rows.find((r) => r.id === tasks[0].id)!.linkCount).toBe(1);
    expect(vm.rows.find((r) => r.id === tasks[2].id)!.linkCount).toBe(0);
  });
});

describe("createProjectsViewModel", () => {
  it("derives milestone progress, health, and active count", () => {
    const projects: Item[] = [
      item({ item_type: "project", title: "P1", metadata: { status: "Active", progress: 10, milestones: [{ id: "m1", text: "a", done: true }, { id: "m2", text: "b", done: false }] } }),
      item({ item_type: "project", title: "P2", metadata: { status: "Paused", progress: 100 } }),
    ];
    const vm = createProjectsViewModel({ projects, links: [], allItems: projects });
    expect(vm.total).toBe(2);
    expect(vm.activeCount).toBe(1);
    const p1 = vm.rows[0];
    expect(p1.derivedProgress).toBe(50); // 1 of 2 milestones
    expect(p1.health).toBe("On track");
    const p2 = vm.rows[1];
    expect(p2.derivedProgress).toBe(100); // no milestones → meta.progress
    expect(p2.health).toBe("Done");
  });
});

describe("createHabitsViewModel", () => {
  it("derives doneToday/pct/daysLeft and XP/level", () => {
    const habits: Item[] = [
      item({ item_type: "habit", title: "H1", metadata: { streak: 5, duration: 10, week: [0, 0, 0, 0, 0, 0, 1], totalDone: 5 } }),
      item({ item_type: "habit", title: "H2", metadata: { streak: 2, duration: 30, week: [0, 0, 0, 0, 0, 0, 0], totalDone: 2 } }),
    ];
    const vm = createHabitsViewModel({ habits });
    expect(vm.longest).toBe(5);
    const h1 = vm.rows[0];
    expect(h1.doneToday).toBe(true);
    expect(h1.pct).toBe(50);
    expect(h1.daysLeft).toBe(5);
    expect(vm.rows[1].doneToday).toBe(false);
    // totalXP = (5*10+5*5) + (2*10+2*5) = 75 + 30 = 105
    expect(vm.totalXP).toBe(105);
    expect(vm.level).toBe(Math.floor(Math.sqrt(105 / 50)) + 1);
  });
});

describe("createCalendarViewModel", () => {
  const now = new Date(2026, 5, 15, 9, 0, 0); // Jun 15 2026
  const cal: Item[] = [
    item({ item_type: "calendar", title: "E1", metadata: { startDate: "2026-06-15T10:00:00", endDate: "2026-06-15T11:00:00", sub: "Event · 1h", color: "var(--h-calendar)" } }),
    item({ item_type: "calendar", title: "E2", metadata: { startDate: "2026-06-16T14:00:00", endDate: "2026-06-16T15:00:00", sub: "Event · 1h", color: "var(--h-calendar)" } }),
  ];
  const tasks: Item[] = [
    item({ item_type: "task", title: "free", metadata: {} }),
    item({ item_type: "task", title: "scheduled", metadata: { date: "2026-06-15" } }),
  ];

  it("projects events with derived time/duration and buckets them", () => {
    const vm = createCalendarViewModel({ calendar: cal, links: [], tasks }, { view: "week", now });
    expect(vm.events).toHaveLength(2);
    const e1 = vm.events[0];
    expect(e1.time).toBe("10:00");
    expect(e1.h).toBe(10);
    expect(e1.dur).toBe(1);
    expect(vm.weekBlocks).toHaveLength(2);
    expect(vm.dayBlocks.map((e) => e.title)).toEqual(["E1"]);
    expect(vm.eventsOn(now)).toHaveLength(1);
    expect(vm.headerTitle).toContain("This week");
  });

  it("groups the agenda by day and lists unscheduled tasks", () => {
    const vm = createCalendarViewModel({ calendar: cal, links: [], tasks }, { view: "agenda", now });
    expect(vm.agenda).toHaveLength(2); // two distinct days
    expect(vm.agenda[0].items.map((e) => e.title)).toEqual(["E1"]);
    expect(vm.unscheduledTasks.map((t) => t.title)).toEqual(["free"]);
  });
});

describe("createBookmarksViewModel", () => {
  const resolve = (id: string) => ({ id, type: "note", title: "Target", icon: "ph-note", color: "", links: [], desc: "", raw: {} as Item, meta: {} });
  const bms: Item[] = [
    item({ item_type: "bookmark", title: "web", metadata: { url: "https://x.com" } }),
    item({ item_type: "bookmark", title: "internal", metadata: { targetId: "note_1", targetType: "note" } }),
  ];

  it("filters by kind and resolves internal targets", () => {
    const all = createBookmarksViewModel({ bookmarks: bms, resolve }, { kind: "all" });
    expect(all.total).toBe(2);
    expect(all.cards).toHaveLength(2);

    const web = createBookmarksViewModel({ bookmarks: bms, resolve }, { kind: "web" });
    expect(web.cards.map((c) => c.item.title)).toEqual(["web"]);
    expect(web.cards[0].isInternal).toBe(false);

    const app = createBookmarksViewModel({ bookmarks: bms, resolve }, { kind: "app" });
    expect(app.cards.map((c) => c.item.title)).toEqual(["internal"]);
    expect(app.cards[0].isInternal).toBe(true);
    expect(app.cards[0].target?.title).toBe("Target");
  });
});

describe("createFilesViewModel", () => {
  const files: Item[] = [
    item({ item_type: "file", title: "beta", metadata: { ext: "md", size: "2 MB", folder: "Docs / sub" } }),
    item({ item_type: "file", title: "alpha", metadata: { ext: "txt", size: "500 KB", folder: "Images" } }),
  ];

  it("sorts rows and collapses folders to their top segment", () => {
    const byName = createFilesViewModel({ files }, { sortKey: "name", sortDir: 1 });
    expect(byName.rows.map((r) => r.item.title)).toEqual(["alpha", "beta"]);
    expect(byName.total).toBe(2);
    expect(byName.folders.sort()).toEqual(["Docs", "Images"]);

    const bySizeDesc = createFilesViewModel({ files }, { sortKey: "size", sortDir: -1 });
    expect(bySizeDesc.rows[0].item.title).toBe("beta"); // 2 MB > 500 KB
  });
});

describe("createNotesViewModel", () => {
  const notes: Item[] = [
    item({ item_type: "note", title: "Alpha", metadata: { folder: "Work", preview: "hello", tag: "x" } }),
    item({ item_type: "note", title: "Beta", metadata: { folder: "Personal", preview: "world", pinned: true } }),
    item({ item_type: "note", title: "Gamma", metadata: { folder: "Work", preview: "foo" } }),
  ];

  it("derives unique folders and floats pinned notes to the top", () => {
    const vm = createNotesViewModel({ notes, links: [], allItems: notes, folderFilter: "all", query: "", activeId: null });
    expect(vm.folders).toEqual(["Work", "Personal"]);
    expect(vm.total).toBe(3);
    expect(vm.list.map((r) => r.item.title)).toEqual(["Beta", "Alpha", "Gamma"]); // pinned first, else store order
    expect(vm.list[0].pinned).toBe(true);
  });

  it("applies folder filter and full-text search", () => {
    const work = createNotesViewModel({ notes, links: [], allItems: notes, folderFilter: "Work", query: "", activeId: null });
    expect(work.list.map((r) => r.item.title)).toEqual(["Alpha", "Gamma"]);

    const search = createNotesViewModel({ notes, links: [], allItems: notes, folderFilter: "all", query: "world", activeId: null });
    expect(search.list.map((r) => r.item.title)).toEqual(["Beta"]);
  });

  it("projects the selected note with its meta and live links", () => {
    const vm = createNotesViewModel({
      notes, links: [link(notes[2].id, notes[0].id)], allItems: notes,
      folderFilter: "all", query: "", activeId: notes[2].id,
    });
    expect(vm.activeNote?.title).toBe("Gamma");
    expect(vm.activeMeta?.folder).toBe("Work");
    expect(vm.activeLinks.map((i) => i.title)).toEqual(["Alpha"]);
  });
});

describe("createLibraryViewModel", () => {
  const lib: Item[] = [
    item({ item_type: "library", title: "Book1", metadata: { mediaType: "book", status: "Reading", progress: { current: 50, total: 200 } } }),
    item({ item_type: "library", title: "Movie1", metadata: { mediaType: "movie", status: "Watched" } }),
    item({ item_type: "library", title: "Game1", metadata: { mediaType: "game", status: "Planned", queue: true } }),
  ];

  it("groups into status shelves with per-card progress derivations", () => {
    const vm = createLibraryViewModel({ items: lib, cat: "all" });
    const shelf = (t: string) => vm.shelves.find((s) => s.title === t);

    const reading = shelf("Reading now")!;
    expect(reading.items[0].title).toBe("Book1");
    expect(reading.items[0].perc).toBe(25);
    expect(reading.items[0].progLabel).toBe("50 / 200 pp");

    const completed = shelf("Completed")!;
    expect(completed.items[0].title).toBe("Movie1");
    expect(completed.items[0].isMovie).toBe(true);
    expect(completed.items[0].perc).toBe(100);
    expect(completed.items[0].progLabel).toBe("Watched");

    // queued item shows on both Up Next and its status shelf
    expect(shelf("Up Next")!.items[0].title).toBe("Game1");
    expect(shelf("Planned")!.items[0].title).toBe("Game1");
  });

  it("filters by media category", () => {
    const vm = createLibraryViewModel({ items: lib, cat: "book" });
    const titles = vm.shelves.flatMap((s) => s.items.map((c) => c.title));
    expect(titles).toEqual(["Book1"]);
  });
});

describe("createVaultViewModel", () => {
  it("projects rows + link counts and never decrypts the secret", () => {
    const vault: Item[] = [item({ item_type: "vault", title: "GH Token", metadata: { kind: "API key", secret: "ENC::abc123" } })];
    const vm = createVaultViewModel({ items: vault, links: [], allItems: vault });
    expect(vm.total).toBe(1);
    expect(vm.list[0].meta.kind).toBe("API key");
    expect(vm.list[0].linkCount).toBe(0);
    // secret passes through ENCRYPTED — the VM must not decrypt or expose plaintext
    expect(vm.list[0].meta.secret).toBe("ENC::abc123");
  });
});

describe("createAutomationViewModel", () => {
  const autos: Item[] = [
    item({ item_type: "automation", title: "A1", metadata: { on: true, runs: 5, trigger: { type: "event", event: "TaskCompleted", entityType: "" }, actions: [{ type: "notify", message: "hi" }] } }),
    item({ item_type: "automation", title: "A2", metadata: { on: false } }),
  ];

  it("derives rows, chain, active count, and engine stat cards", () => {
    const stats: any = { total_executions: 10, success_rate: 0.8, failed: 2, avg_duration_ms: 123.6, running: 1 };
    const vm = createAutomationViewModel({ items: autos, links: [], allItems: autos, stats });
    expect(vm.total).toBe(2);
    expect(vm.activeCount).toBe(1);
    expect(vm.rows[0].chain.length).toBeGreaterThan(0); // deriveChain produced When/Then nodes
    expect(vm.statCards.map((c) => c.value)).toEqual([1, 10, "80%", 2, "124ms", 1]);
  });

  it("renders placeholder stats when the engine has no data yet", () => {
    const vm = createAutomationViewModel({ items: autos, links: [], allItems: autos, stats: null });
    expect(vm.statCards.find((c) => c.label === "success rate")!.value).toBe("—");
    expect(vm.statCards.find((c) => c.label === "avg duration")!.value).toBe("—");
  });

  it("derives simple options listing", () => {
    const vm = createAutomationViewModel({ items: autos, links: [], allItems: autos, stats: null });
    expect(vm.options).toHaveLength(2);
    expect(vm.options[0].title).toBe("A1");
  });
});

describe("filterExecutions", () => {
  const rows: any = [{ status: "SUCCESS" }, { status: "FAILED" }, { status: "SUCCESS" }];
  it("filters by status, passes ALL through, and tolerates null", () => {
    expect(filterExecutions(rows, "ALL")).toHaveLength(3);
    expect(filterExecutions(rows, "FAILED").map((r) => r.status)).toEqual(["FAILED"]);
    expect(filterExecutions(null, "ALL")).toEqual([]);
  });
});

describe("createGraphViewModel", () => {
  const graphItems: Item[] = [
    item({ item_type: "note", title: "N1" }),
    item({ item_type: "task", title: "T1" }),
    item({ item_type: "project", title: "P1" }),
  ];
  const graphLinks: Link[] = [
    link(graphItems[0].id, graphItems[1].id), // N1 -> T1 (both visible in 'all')
    link(graphItems[1].id, graphItems[2].id), // T1 -> P1
  ];

  it("filters nodes and edges based on typeFilter Set", () => {
    const allVm = createGraphViewModel({ items: graphItems, links: graphLinks }, new Set(["all"]));
    expect(allVm.nodeCount).toBe(3);
    expect(allVm.edgeCount).toBe(2);

    const notesVm = createGraphViewModel({ items: graphItems, links: graphLinks }, new Set(["note"]));
    expect(notesVm.nodeCount).toBe(1);
    expect(notesVm.nodes[0].title).toBe("N1");
    expect(notesVm.edgeCount).toBe(0); // no edges between note and note since only 1 node is visible

    const noteTaskVm = createGraphViewModel({ items: graphItems, links: graphLinks }, new Set(["note", "task"]));
    expect(noteTaskVm.nodeCount).toBe(2);
    expect(noteTaskVm.edgeCount).toBe(1); // N1 -> T1 is included, but T1 -> P1 is excluded because P1 is not visible
    expect(noteTaskVm.edges[0].source).toBe(graphItems[0].id);
    expect(noteTaskVm.edges[0].target).toBe(graphItems[1].id);
  });
});
