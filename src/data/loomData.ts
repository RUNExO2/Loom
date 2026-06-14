/* ============================================================
   LOOM — Seed dataset (persona: SWE + university student)
   ONE-TIME source for populating an empty SQLite database. This file
   is imported ONLY by itemStore.seedAll(); nothing reads it at render
   time. After the seed, SQLite is the sole source of truth.
   ============================================================ */

import { MOD } from "../lib/typeMeta";

const ICON = {
  project: "ph-kanban", note: "ph-note", task: "ph-check-square", file: "ph-file",
  bookmark: "ph-bookmark-simple", media: "ph-stack", habit: "ph-pulse", event: "ph-circle",
  book: "ph-book-open", anime: "ph-television", manga: "ph-book-bookmark", game: "ph-game-controller",
  vault: "ph-vault",
};

export const projects = [
  { id: "p-gng", type: "project", icon: "ph-game-controller", title: "Nexus", subtitle: "Roguelite on a custom ECS engine",
    status: "Active", progress: 64, color: MOD.projects, tag: "NEXUS",
    desc: "A pixel-art roguelite built on a hand-rolled Entity-Component-System engine in Rust + wgpu. Procedural dungeons, deterministic replay, hot-reload.",
    meta: { tasks: 12, openTasks: 5, notes: 6, files: 4, commits: 318, lang: "Rust" },
    links: ["n-ecs", "n-render", "n-dungeon", "t-gng-1", "t-gng-2", "t-gng-3", "f-gng-design", "f-gng-tilemap", "b-wgpu", "b-lague", "m-gpp", "tl-gng-milestone", "tl-gng-commit"] },
  { id: "p-thesis", type: "project", icon: "ph-graduation-cap", title: "Thesis — Distributed Consensus", subtitle: "CS honors capstone",
    status: "Active", progress: 38, color: MOD.projects, tag: "THESIS",
    desc: "Empirical comparison of Raft vs. Paxos variants under partition. Built a deterministic network simulator for reproducible failure injection.",
    meta: { tasks: 9, openTasks: 6, notes: 4, files: 7, commits: 92, lang: "Go" },
    links: ["n-raft", "t-thesis-1", "t-thesis-2", "f-thesis-draft", "b-raft-paper", "m-ddia"] },
  { id: "p-portfolio", type: "project", icon: "ph-globe", title: "Portfolio v3", subtitle: "Personal site rebuild",
    status: "Active", progress: 80, color: MOD.projects, tag: "PORT",
    desc: "Rebuilding the personal site with a focus on the projects archive and a /now page wired to LOOM.",
    meta: { tasks: 6, openTasks: 1, notes: 2, files: 3, commits: 140, lang: "TS" },
    links: ["t-port-1", "b-shaders"] },
  { id: "p-lox", type: "project", icon: "ph-tree-structure", title: "Lox Compiler", subtitle: "Crafting Interpreters follow-along",
    status: "Paused", progress: 52, color: MOD.projects, tag: "LOX",
    desc: "A bytecode VM for the Lox language. Currently on garbage collection.",
    meta: { tasks: 4, openTasks: 2, notes: 1, files: 2, commits: 76, lang: "C" },
    links: ["b-craftinginterp"] },
  { id: "p-homelab", type: "project", icon: "ph-hard-drives", title: "Home Lab", subtitle: "Self-hosted services",
    status: "Maintained", progress: 90, color: MOD.projects, tag: "LAB",
    desc: "Proxmox cluster running media, backups, and a personal CI runner.",
    meta: { tasks: 3, openTasks: 1, notes: 1, files: 1, commits: 0, lang: "—" },
    links: [] },
];

export const notes = [
  { id: "n-ecs", type: "note", icon: ICON.note, title: "ECS Architecture — sparse sets vs archetypes", color: MOD.notes,
    folder: "Nexus / Engine", updated: "2d ago", words: 1240, tag: "NEXUS",
    preview: "Archetype storage gives cache-friendly iteration but pays on add/remove. For Nexus the component churn is high during combat, so a hybrid…",
    links: ["p-gng", "n-render", "b-wgpu", "f-gng-design", "m-gpp"],
    body: [
      { h2: "The core decision" },
      { p: "Two dominant storage strategies for an ECS: <b>archetypes</b> (group entities by exact component set) and <b>sparse sets</b> (one packed array per component). For Nexus, combat spawns and despawns thousands of projectile entities per second, so component churn is the dominant cost." },
      { p: "Archetype storage gives the best iteration locality, but every add/remove migrates the entity between archetype tables. Sparse sets make add/remove O(1) at the cost of slightly worse iteration." },
      { h2: "Decision" },
      { p: "Hybrid: sparse sets for high-churn components (Projectile, Damage, Lifetime), archetypes for stable ones (Transform, Sprite). See the benchmark in the design doc." },
      { code: "// hot path: query<(Transform, Sprite)> iterates an archetype\n// cold path: world.remove::<Projectile>(e) is O(1)\nfor (t, s) in q.iter() {\n    renderer.push(s.tile, t.pos);\n}" },
      { p: "Related: the rendering pipeline depends on this iteration order — see linked note." },
    ] },
  { id: "n-render", type: "note", icon: ICON.note, title: "Rendering pipeline — batched tilemap draw", color: MOD.notes,
    folder: "Nexus / Engine", updated: "4d ago", words: 880, tag: "NEXUS",
    preview: "Single instanced draw call for the whole visible tilemap. Glyphs are packed into one atlas; the instance buffer holds (tile_id, pos, tint)…",
    links: ["p-gng", "n-ecs", "b-wgpu", "b-lague"],
    body: [
      { h2: "Goal: one draw call per layer" },
      { p: "The whole visible tilemap renders as a single instanced draw. Glyphs live in one atlas; the per-instance buffer is <code>(tile_id, world_pos, tint)</code>. At 60fps the buffer is rebuilt only for dirty chunks." },
      { h2: "wgpu specifics" },
      { p: "Using a storage buffer for instance data indexed by <code>@builtin(instance_index)</code>. This avoids vertex-buffer churn entirely." },
    ] },
  { id: "n-dungeon", type: "note", icon: ICON.note, title: "Procedural dungeon generation — drunkard + BSP", color: MOD.notes,
    folder: "Nexus / Design", updated: "1w ago", words: 640, tag: "NEXUS",
    preview: "BSP for room placement, drunkard's walk for organic corridors, then a connectivity pass that guarantees every room is reachable…",
    links: ["p-gng", "f-gng-design", "b-lague", "m-gpp"],
    body: [
      { h2: "Two-stage generation" },
      { p: "BSP partitions the level into room candidates; a drunkard's-walk carves organic corridors between them. A final flood-fill guarantees full connectivity." },
      { p: "Determinism matters for replay — the generator takes an explicit <code>u64</code> seed and never touches global RNG." },
    ] },
  { id: "n-raft", type: "note", icon: ICON.note, title: "Raft — leader election & the split-vote problem", color: MOD.notes,
    folder: "Thesis", updated: "3d ago", words: 1520, tag: "THESIS",
    preview: "Randomized election timeouts are the whole trick. Without them, symmetric timeouts cause repeated split votes under partition…",
    links: ["p-thesis", "b-raft-paper", "m-ddia"],
    body: [
      { h2: "Why randomized timeouts" },
      { p: "Symmetric election timeouts cause repeated split votes: every follower times out at once, all become candidates, all vote for themselves. Randomizing the timeout window (150–300ms) makes one candidate almost always win the race." },
      { h2: "Simulator note" },
      { p: "My deterministic network sim injects partitions on a virtual clock so a split-vote scenario is fully reproducible." },
    ] },
  { id: "n-lecture", type: "note", icon: ICON.note, title: "Lecture — CS4400 query optimization", color: MOD.notes,
    folder: "Coursework", updated: "5d ago", words: 420, tag: "CS4400",
    preview: "Cost-based optimizer: estimate cardinality, pick join order via dynamic programming (System R style). Histograms for selectivity…",
    links: ["m-ddia"], body: [{ h2: "Join ordering" }, { p: "System-R style DP over join orders. Cardinality estimation via histograms drives selectivity." }] },
  { id: "n-japanese", type: "note", icon: ICON.note, title: "日本語 — grammar: は vs が", color: MOD.notes,
    folder: "Language", updated: "1d ago", words: 310, tag: "JP",
    preview: "は marks the topic (known/contrast), が marks the subject (new info, neutral description). The classic 'who did it?' → が answer…",
    links: [], body: [{ h2: "Topic vs subject" }, { p: "は marks topic; が marks subject (new info). Answering 'who?' takes が." }] },
];

export const tasks = [
  { id: "t-gng-1", type: "task", icon: ICON.task, title: "Fix archetype migration leak in combat", color: MOD.tasks, done: false, priority: "high", due: "Today", project: "Nexus", links: ["p-gng", "n-ecs"] },
  { id: "t-gng-2", type: "task", icon: ICON.task, title: "Instance buffer: rebuild only dirty chunks", color: MOD.tasks, done: false, priority: "med", due: "Today", project: "Nexus", links: ["p-gng", "n-render"] },
  { id: "t-gng-3", type: "task", icon: ICON.task, title: "Seed-stable dungeon gen for replay", color: MOD.tasks, done: true, priority: "med", due: "Yesterday", project: "Nexus", links: ["p-gng", "n-dungeon"] },
  { id: "t-thesis-1", type: "task", icon: ICON.task, title: "Write up split-vote reproduction", color: MOD.tasks, done: false, priority: "high", due: "Today", project: "Thesis", links: ["p-thesis", "n-raft"] },
  { id: "t-thesis-2", type: "task", icon: ICON.task, title: "Run partition sweep (n=5,7,9)", color: MOD.tasks, done: false, priority: "med", due: "Fri", project: "Thesis", links: ["p-thesis"] },
  { id: "t-port-1", type: "task", icon: ICON.task, title: "Wire /now page to LOOM export", color: MOD.tasks, done: false, priority: "low", due: "Next wk", project: "Portfolio", links: ["p-portfolio"] },
  { id: "t-read-1", type: "task", icon: ICON.task, title: "Read DDIA ch.9 (consistency)", color: MOD.tasks, done: false, priority: "med", due: "Today", project: "Thesis", links: ["m-ddia", "p-thesis"] },
  { id: "t-misc-1", type: "task", icon: ICON.task, title: "Submit CS4400 problem set 6", color: MOD.tasks, done: false, priority: "high", due: "Today", project: "CS4400", links: ["n-lecture"] },
  { id: "t-misc-2", type: "task", icon: ICON.task, title: "Renew domain + DNS for portfolio", color: MOD.tasks, done: true, priority: "low", due: "Yesterday", project: "Portfolio", links: ["p-portfolio"] },
];

export const habits = [
  { id: "h-1", title: "LeetCode (1/day)", color: MOD.habits, streak: 23, week: [1,1,1,1,1,0,1] as number[], goal: "Daily", links: [] },
  { id: "h-2", title: "Read 30 min", color: MOD.habits, streak: 11, week: [1,1,0,1,1,1,1] as number[], goal: "Daily", links: ["m-ddia", "m-gpp"] },
  { id: "h-3", title: "Workout", color: MOD.habits, streak: 4, week: [0,1,0,1,1,0,1] as number[], goal: "4×/week", links: [] },
  { id: "h-4", title: "Japanese review", color: MOD.habits, streak: 47, week: [1,1,1,1,1,1,1] as number[], goal: "Daily", links: ["n-japanese"] },
  { id: "h-5", title: "No caffeine after 2pm", color: MOD.habits, streak: 6, week: [1,1,1,0,1,1,1] as number[], goal: "Daily", links: [] },
  { id: "h-6", title: "Ship a commit", color: MOD.habits, streak: 31, week: [1,1,1,1,1,1,0] as number[], goal: "Daily", links: ["p-gng"] },
];

export const media = [
  { id: "m-gpp", type: "media", kind: "book", icon: ICON.book, title: "Game Programming Patterns", color: MOD.library, creator: "Robert Nystrom", cat: "Reading", status: "Reading", progress: 72, of: "ch. 14 / 20", tag: "NEXUS", links: ["p-gng", "n-ecs", "n-dungeon", "h-2"] },
  { id: "m-ddia", type: "media", kind: "book", icon: ICON.book, title: "Designing Data-Intensive Apps", color: MOD.library, creator: "Martin Kleppmann", cat: "Reading", status: "Reading", progress: 45, of: "ch. 9 / 12", tag: "THESIS", links: ["p-thesis", "n-raft", "n-lecture", "t-read-1"] },
  { id: "m-craft", type: "media", kind: "book", icon: ICON.book, title: "Crafting Interpreters", color: MOD.library, creator: "Robert Nystrom", cat: "Reading", status: "Paused", progress: 60, of: "Bytecode VM", links: ["p-lox"] },
  { id: "m-frieren", type: "media", kind: "anime", icon: ICON.anime, title: "Frieren: Beyond Journey's End", color: MOD.library, creator: "Madhouse", cat: "Watching", status: "Watching", progress: 71, of: "ep 20 / 28", links: [] },
  { id: "m-vinland", type: "media", kind: "anime", icon: ICON.anime, title: "Vinland Saga S2", color: MOD.library, creator: "MAPPA", cat: "Watching", status: "Watching", progress: 50, of: "ep 12 / 24", links: [] },
  { id: "m-berserk", type: "media", kind: "manga", icon: ICON.manga, title: "Berserk", color: MOD.library, creator: "Kentaro Miura", cat: "Reading", status: "Reading", progress: 88, of: "vol 40 / 41", links: [] },
  { id: "m-chainsaw", type: "media", kind: "manga", icon: ICON.manga, title: "Chainsaw Man", color: MOD.library, creator: "Tatsuki Fujimoto", cat: "Reading", status: "Caught up", progress: 100, of: "ch. 158", links: [] },
  { id: "m-hades", type: "media", kind: "game", icon: ICON.game, title: "Hades II", color: MOD.library, creator: "Supergiant", cat: "Playing", status: "Playing", progress: 64, of: "32h", tag: "NEXUS", links: ["p-gng"] },
  { id: "m-tunic", type: "media", kind: "game", icon: ICON.game, title: "Tunic", color: MOD.library, creator: "Andrew Shouldice", cat: "Playing", status: "Completed", progress: 100, of: "Cleared", links: [] },
  { id: "m-elden", type: "media", kind: "game", icon: ICON.game, title: "Elden Ring", color: MOD.library, creator: "FromSoftware", cat: "Playing", status: "Completed", progress: 100, of: "118h", links: [] },
];

export const files: any[] = [];

export const bookmarks = [
  { id: "b-wgpu", type: "bookmark", icon: ICON.bookmark, title: "wgpu — Bind Group Layouts", color: MOD.bookmarks, site: "docs.rs/wgpu", folder: "Nexus / Graphics", links: ["p-gng", "n-render", "n-ecs"] },
  { id: "b-lague", type: "bookmark", icon: ICON.bookmark, title: "Sebastian Lague — Procedural Generation", color: MOD.bookmarks, site: "youtube.com", folder: "Nexus / Design", links: ["p-gng", "n-dungeon", "n-render"] },
  { id: "b-raft-paper", type: "bookmark", icon: ICON.bookmark, title: "In Search of an Understandable Consensus Algorithm", color: MOD.bookmarks, site: "raft.github.io", folder: "Thesis", links: ["p-thesis", "n-raft"] },
  { id: "b-craftinginterp", type: "bookmark", icon: ICON.bookmark, title: "Crafting Interpreters — Garbage Collection", color: MOD.bookmarks, site: "craftinginterpreters.com", folder: "Lox", links: ["p-lox"] },
  { id: "b-shaders", type: "bookmark", icon: ICON.bookmark, title: "The Book of Shaders", color: MOD.bookmarks, site: "thebookofshaders.com", folder: "Portfolio", links: ["p-portfolio"] },
];

export const vault = [
  { id: "v-1", title: "GitHub — personal token", color: MOD.vault, kind: "API key", icon: "ph-github-logo", updated: "Updated 2w ago", links: ["p-gng", "p-portfolio"] },
  { id: "v-2", title: "University SSO", color: MOD.vault, kind: "Login", icon: "ph-graduation-cap", updated: "Updated 1mo ago", links: ["p-thesis"] },
  { id: "v-3", title: "Proxmox root", color: MOD.vault, kind: "Login", icon: "ph-hard-drives", updated: "Updated 3d ago", links: ["p-homelab"] },
  { id: "v-4", title: "Cloud — deploy keys", color: MOD.vault, kind: "SSH key", icon: "ph-cloud", updated: "Updated 5d ago", links: ["p-portfolio"] },
  { id: "v-5", title: "Recovery codes — 2FA", color: MOD.vault, kind: "Secure note", icon: "ph-shield-check", updated: "Updated 2mo ago", links: [] },
  { id: "v-6", title: "Steam", color: MOD.vault, kind: "Login", icon: "ph-game-controller", updated: "Updated 6mo ago", links: ["m-hades"] },
];

export const automations = [
  { id: "a-1", title: "Task completed → log a follow-up note", color: MOD.automation, on: true, runs: 0,
    desc: "Whenever any task is marked done, drop a follow-up note so nothing falls through.",
    trigger: { type: "event", event: "TaskCompleted" },
    actions: [{ type: "createNote", title: "Follow-up after completed task" }], links: ["p-gng"] },
  { id: "a-2", title: "High-priority task created → notify", color: MOD.automation, on: true, runs: 0,
    desc: "When a new task is created with priority = high, raise a notification.",
    trigger: { type: "event", event: "TaskCreated" },
    conditions: { op: "AND", rules: [{ field: "metadata.priority", cmp: "eq", value: "high" }] },
    actions: [{ type: "notify", message: "New high-priority task" }], links: [] },
  { id: "a-3", title: "Book finished → create review note", color: MOD.automation, on: true, runs: 0,
    desc: "When a Library item reaches 100%, create a stub review note.",
    trigger: { type: "event", event: "LibraryCompleted" },
    actions: [{ type: "createNote", title: "Review: finished item" }], links: ["m-gpp"] },
  { id: "a-4", title: "Daily 08:00 digest", color: MOD.automation, on: false, runs: 0,
    desc: "Every morning at 08:00, fire a digest notification. Enable to activate the scheduler.",
    trigger: { type: "daily", time: "08:00" },
    actions: [{ type: "notify", message: "Morning digest" }], links: [] },
];

export const timeline = [
  { id: "tl-1", kind: "habit", color: MOD.habits, icon: "ph-pulse", when: "Today · 9:12", title: "47-day streak on Japanese review", sub: "Longest active streak", links: ["h-4", "n-japanese"], month: "June 2026", fill: true },
  { id: "tl-gng-commit", kind: "commit", color: MOD.projects, icon: "ph-git-commit", when: "Today · 8:40", title: "Nexus · 3 commits — fix archetype migration", sub: "feat: dirty-chunk instance rebuild · +412 −96", links: ["p-gng", "n-ecs", "f-gng-bench"], month: "June 2026", fill: true },
  { id: "tl-2", kind: "task", color: MOD.tasks, icon: "ph-check-circle", when: "Yesterday", title: "Completed: Seed-stable dungeon gen for replay", sub: "Nexus · marked done", links: ["t-gng-3", "p-gng", "n-dungeon"], month: "June 2026" },
  { id: "tl-3", kind: "note", color: MOD.notes, icon: "ph-note-pencil", when: "Jun 8", title: "Created note · Raft — leader election", sub: "Thesis · 1,520 words", links: ["n-raft", "p-thesis"], month: "June 2026" },
  { id: "tl-gng-milestone", kind: "milestone", color: MOD.projects, icon: "ph-flag-banner", when: "Jun 4", title: "Nexus reached 64% — combat vertical slice playable", sub: "Milestone · vertical slice", links: ["p-gng"], month: "June 2026", fill: true },
  { id: "tl-4", kind: "media", color: MOD.library, icon: "ph-game-controller", when: "May 27", title: "Completed: Tunic", sub: "Game · 100% · 24h", links: ["m-tunic"], month: "May 2026", fill: true },
  { id: "tl-5", kind: "book", color: MOD.library, icon: "ph-book-open", when: "May 21", title: "Finished: The Pragmatic Programmer", sub: "Reading · created review note", links: [], month: "May 2026" },
  { id: "tl-6", kind: "project", color: MOD.projects, icon: "ph-folder-plus", when: "May 12", title: "Started project · Thesis — Distributed Consensus", sub: "Capstone kickoff", links: ["p-thesis", "f-thesis-draft"], month: "May 2026", fill: true },
  { id: "tl-7", kind: "habit", color: MOD.habits, icon: "ph-trophy", when: "May 3", title: "30-day LeetCode streak", sub: "Habit milestone", links: ["h-1"], month: "May 2026" },
  { id: "tl-8", kind: "media", color: MOD.library, icon: "ph-television", when: "Apr 28", title: "Finished: Cyberpunk: Edgerunners", sub: "Anime · 10 ep", links: [], month: "April 2026" },
  { id: "tl-9", kind: "project", color: MOD.projects, icon: "ph-game-controller", when: "Apr 9", title: "Started project · Nexus", sub: "First commit — ECS skeleton", links: ["p-gng", "n-ecs"], month: "April 2026", fill: true },
  { id: "tl-10", kind: "book", color: MOD.library, icon: "ph-book-open", when: "Apr 2", title: "Started: Designing Data-Intensive Apps", sub: "Reading", links: ["m-ddia"], month: "April 2026" },
];

export const agenda = [
  { time: "09:00", title: "Standup — Thesis advisor", sub: "Video call · 30m", color: MOD.calendar },
  { time: "11:00", title: "CS4400 Lecture", sub: "Query optimization · Hall B", color: MOD.calendar, links: ["n-lecture"] },
  { time: "14:00", title: "Nexus — combat playtest", sub: "Focus block · 2h", color: MOD.projects, links: ["p-gng"] },
  { time: "17:30", title: "Gym", sub: "Push day", color: MOD.habits, links: ["h-3"] },
  { time: "20:00", title: "Frieren ep 21", sub: "Wind-down", color: MOD.library, links: ["m-frieren"] },
];

// Seed bundle — the only export, consumed exclusively by itemStore.seedAll().
export const D = { MOD, projects, notes, tasks, habits, media, files, bookmarks, vault, automations, timeline, agenda };
