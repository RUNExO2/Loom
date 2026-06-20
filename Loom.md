# LOOM — Master Plan

This document merges the original **4-phase plan** with the findings from the
codebase teardown. Original phases are preserved verbatim (Includes + Claude
Prompt). Under each, **➕ Added from teardown** lists *new* items that belong in
that phase but weren't in the original list. Four **new strategic phases (5–8)**
cover the gaps that cap Loom's ceiling. Appendices A–H hold the full backlog,
each row tagged with its target phase so there is one plan, not two.

Bracketed tags like `[D2]`, `[A3]` reference the appendix backlog rows.

---

## Strategic Context — why this order

| # | Strategic problem | Why it's existential | Lands in |
|---|---|---|---|
| S1 | No sync / mobile / web — pure local single device | Every category leader is multi-device; caps the market | Phase 6 |
| S2 | Notes stored as **HTML files**, not Markdown | Blocks sync, export, portability, git, clean AI | Phase 5 |
| S3 | No live `[[backlinks]]` / block refs while typing | The core PKM loop (Roam/Obsidian/Logseq) is absent | Phase 3 |
| S4 | Reliability layer over-engineered; UX under-engineered | Per-write full-table integrity + 30s sweeps = perf tax + slow velocity | Phase 1 |
| S5 | No plugin system; closed modules + "Coming soon" dead ends | Obsidian's moat is plugins; closed set caps extensibility | Phase 8 |

**Verdict:** Loom built enterprise-grade *local durability* around a consumer notes
app that stores HTML, can't sync, and has no real graph. The effort is inverted.
Phases 1–4 make Loom a credible, polished PKM. Phases 5–8 are where it stops
matching competitors and starts beating them (local-AI-over-your-own-graph is the
wedge no cloud incumbent can copy).

---

## Roadmap at a glance

| Phase | Goal | Impact | Effort |
|---|---|---|---|
| 1 | Reliability & Scalability Foundation | Massive | Med–Hard |
| 2 | Core Productivity Features | Extremely High | Medium |
| 3 | Workspaces & Knowledge Graph | Differentiating | Medium |
| 4 | Premium Polish | Feels finished | Medium |
| **5** | **Data Foundation (Markdown + sync-ready model)** | **Critical / unblocks 6–8** | Hard |
| **6** | **Multi-Device & Mobile (E2E sync)** | **Market-expanding** | Hard |
| **7** | **Local AI & Knowledge Intelligence** | **The wedge** | Medium |
| **8** | **Extensibility & Ecosystem (plugins)** | **Flywheel** | Hard |

---

# PHASE 1 — Reliability & Scalability Foundation

**Expected Impact: Massive**

**Goal:** Remove architectural debt before adding anything new.

### Includes
- Add `updated_at` column + migration + triggers
- Remove MutationEngine completely
- Remove frontend integrity verification calls
- Replace full integrity scans with targeted validation
- Fix automation nested transaction bug
- Remove SplitBrainVerifier from production
- Remove unused dependencies
- Remove dead seed system
- Remove greet command
- Memoize navigation/badge computations
- Remove event-bus roundtrip for local state mutations
- Add pagination infrastructure
- Virtualize all large module lists
- Move Playwright to devDependencies
- Remove unused Zustand
- Remove unused React Router

### Claude Prompt
> You are performing Phase 1 of a large-scale architectural optimization of LOOM.
>
> **Primary Objective:** Improve reliability, scalability, maintainability, and performance WITHOUT changing user-facing behavior.
>
> **Requirements:**
> 1. **Add `updated_at` support:** Create migration. Backfill existing records. Add automatic update trigger. Replace all "recently edited" heuristics with `updated_at`.
> 2. **Remove MutationEngine completely:** Delete `mutationEngine.ts`. Remove all wrappers around store mutations. Preserve undo/redo behavior. Preserve Rust transaction guarantees.
> 3. **Remove redundant integrity verification:** Eliminate frontend `verifyIntegrity` calls. Eliminate repeated full integrity scans during normal CRUD. Keep SQLite foreign key guarantees. Replace with targeted validation only when necessary.
> 4. **Fix transaction nesting:** Make `execute_two_phase` SAVEPOINT-aware. Ensure automation workflows function correctly inside existing transactions.
> 5. **Virtualize all large lists:** Reuse existing Dashboard virtualization strategy. Apply to tasks, notes, files, events, bookmarks, and any potentially large collections.
> 6. **Remove production-only architectural debt:** SplitBrainVerifier becomes DEV-only. Remove greet command. Remove dead seed system. Remove unused Zustand. Remove unused React Router. Move Playwright to devDependencies.
> 7. **Optimize render paths:** Memoize `buildNav`. Remove unnecessary event-bus roundtrips for same-window updates. Update React state directly when possible.
>
> **Constraints:** No feature additions. No visual redesign. No behavioral regressions. No temporary compatibility layers. Prefer deletion over abstraction. Produce clean final architecture.
>
> **Before editing:** Create a detailed execution plan.
> **After implementation:** Produce a migration report listing: files changed, code removed, performance improvements, risk areas, testing performed.

### ➕ Added from teardown (fits Phase 1)
- **Event-driven / idle-backoff integrity sweep** — replace the 30s full filesystem+DB sweep in `App.tsx` and widen the 30s scheduler poll. Biggest idle CPU/battery drain. `[D2]`
- **Move file I/O off the DB thread** in `index_text_files` (read/parse via `tokio::spawn`, batch into SQLite). Stops UI freeze during indexing. `[D3]`
- **Delta-integrity in `execute_two_phase`** — validate only the mutated rows' endpoints/workspace, not full-table scans ×2 per write. (This *is* the "targeted validation" requirement — make it explicit.) `[D1]`
- **Incremental store via the mutation-ledger change feed** — complements pagination; avoids full `refresh()` reloads. `[D4][D5]`
- **Bundle mermaid locally** — kill the runtime CDN fetch (`Modules.tsx`); restores offline-first. `[D7]`
- **Background engine off by default** + honor `prefers-reduced-motion`; throttle/remove the always-on mousemove parallax listener. `[B22][D13]`
- **Replace `window.prompt()`/`confirm()`** (NoteEditor link, MediaTools embed) with the existing `modal.form`. Cheap, no behavior change in outcome. `[B1]`
- **Debounced, no-op-skipping autosave** (content-hash guard) for notes. `[B2]`
- **Structured error types (`thiserror`)** across the IPC boundary (replace blanket `.map_err(|e| e.to_string())`). `[E5]`
- **Split `Modules.tsx` / `Modules2.tsx`** into per-module files. `[E6]`
- **Note:** removing SplitBrainVerifier from production is a *symptom fix*; the *cause* (multi-source state) is resolved in **Phase 5** (single reactive store). Keep the dev-only verifier until then.

---

# PHASE 2 — Core Productivity Features

**Expected Impact: Extremely High**

**Goal:** Add features users actually notice.

### Includes
- Bulk actions · Multi-select · Task dependencies · Subtasks · Saved views
- Smart folders · Tag browser · Recent commands · Command frecency
- Recently deleted UI · Better undo UI · Quick-add everywhere

### Claude Prompt
> You are implementing Phase 2 of LOOM.
>
> **Objective:** Add high-value productivity functionality while preserving the existing architecture.
>
> **Features:**
> - **Multi-select system:** Shift-select, Ctrl-select, keyboard support, works across all major modules.
> - **Bulk actions:** Delete, Move workspace, Add/remove tags, Link items, Change status, Change priority.
> - **Task hierarchy:** Subtasks, parent-child relationships, dependency relationships. Reuse existing links table whenever possible.
> - **Saved Views:** User-defined filtered collections, sidebar pinning, dynamic updates, smart-folder behavior.
> - **Tag Browser:** Global tag index, tag counts, click-to-filter navigation.
> - **Command Palette Improvements:** Recent commands, frecency ranking, better match highlighting, loading states, search chips, saved-search management.
> - **Undo Improvements:** Visible history panel, failed action visibility, recently deleted access.
> - **Universal Quick Add:** Reuse existing capture parser, available inside all modules.
>
> **Requirements:** Reuse existing infrastructure wherever possible. Avoid creating duplicate data models. Favor projection layers over new tables. Maintain keyboard-first workflows.
>
> **Deliver:** Architecture report, database changes, UX changes, future extension points.

### ➕ Added from teardown (fits Phase 2)
- **Daily notes / journal** — auto-created "Today" note, default capture target. Core PKM loop. `[A6]`
- **Templates** (notes/tasks/projects) with `{{date}}`/`{{title}}` variables; `templates.ts` is already nascent. `[A9]`
- **Find-in-note** `Ctrl+F`. `[B5]`
- **Quick-switcher** `Ctrl+O` to jump to any item. `[B18]`
- **Natural-language due dates** ("tomorrow 5pm") reusing the capture parser. `[C18]`
- **Drag-to-link** between items. `[B8]`
- **Native `<input type="date">`** pickers for due dates (CSS/native over a lib). `[B11]`
- **Trash retention + "empty trash"** alongside the recently-deleted UI. `[B16]`
- **Real capture modal** to replace the DOM-typing hack in `App.tsx` (the "Quick Add everywhere" requirement should not be built on simulated input events). `[B4]`

---

# PHASE 3 — Workspaces & Knowledge Graph

**Expected Impact: Differentiates LOOM from competitors**

### Includes
- Workspace UI · Workspace switching · Workspace templates · Cross-workspace search
- Graph visualization · Graph analytics · Relationship exploration

### Claude Prompt
> You are implementing Phase 3 of LOOM.
>
> **Objective:** Expose the powerful capabilities already present in the backend.
>
> **Features:**
> - **Complete Workspace Support:** Workspace switcher, management UI, creation, deletion, templates, settings.
> - **Cross Workspace Search:** Fast workspace-scoped search, global search mode, workspace filtering.
> - **Graph View:** Visual graph explorer, existing links become graph edges, zooming, panning, selection, focus mode.
> - **Graph Analytics:** Most connected nodes, orphaned nodes, relationship statistics, workspace graph metrics.
> - **Knowledge Navigation:** Backlinks, forward links, related items, relationship explorer.
>
> **Requirements:** Use existing relations infrastructure. Avoid introducing parallel graph models. Keep graph rendering performant for large datasets. Lazy-load graph data where possible.
>
> **Deliver:** Architecture report, performance analysis, scaling strategy, UX walkthrough.

### ➕ Added from teardown (fits Phase 3)
- **Live `[[wikilink]]` autocomplete that writes a real `links` row** — TipTap suggestion node. Today wikilinks are dead `data-wikilink` anchors only from Obsidian import. This is the missing core loop. `[A3]`
- **Backlinks panel = linked *and* unlinked mentions** (full-text scan for the latter), surfaced inline at the bottom of each note. `[A4][C16]`
- **Block references & note transclusion/embeds** (block IDs + `((ref))` + a `noteEmbed` node). `[A7]`
- **Query blocks** — live filtered lists embedded in notes ("tasks where status=open and project=X"). `[A14]`
- **Graph-aware search ranking** — boost results by link distance to the current item. `[F16]`
- **"Second brain health"** view (orphans / stale / unlinked) — extends Graph Analytics' orphaned-nodes. `[F25]`
- **Nested tags** `#a/b` (already parsed on import) in the Tag Browser. `[A20]`

---

# PHASE 4 — Premium Polish

**Expected Impact: Makes LOOM feel finished**

### Includes
- Notifications · Recurring task UI · Calendar upgrades · Attachment previews
- Backup scheduling · Export improvements · Empty states · Breadcrumb upgrades
- Keyboard discovery · QoL improvements

### Claude Prompt
> You are implementing Phase 4 of LOOM.
>
> **Objective:** Transform LOOM from a powerful application into a polished product.
>
> **Features:**
> - **Notifications:** Due reminders, event reminders, recurring task reminders, native Tauri notifications.
> - **Recurring Task UX:** Next occurrence, skip, snooze, visual indicators.
> - **Calendar Improvements:** Recurring events, ICS import, ICS export.
> - **Attachment System:** PDF preview, image preview, rich preview cards.
> - **Backup System:** Scheduled backups, retention settings, restore UI.
> - **Export System:** Markdown export, CSV export, workspace export, smart-folder export.
> - **Quality-of-Life:** Better breadcrumbs, empty states, keyboard shortcut discoverability, search improvements, improved deletion recovery, better toasts, persisted command palette settings.
> - **UX Consistency Pass:** Remove rough edges, normalize interactions, improve accessibility, improve responsiveness.
>
> **Requirements:** No architectural rewrites. Build on previous phases. Preserve performance. Maintain keyboard-first workflows.
>
> **Deliver:** Product polish report, UX audit, accessibility audit, final release readiness report.

### ➕ Added from teardown (fits Phase 4)
- **ICS *subscribe* (two-way)**, not just import/export — you only export ICS today (`Modules2.tsx`). `[A16]`
- **Accessibility pass with teeth:** focus traps in modals/palette, non-color status indicators, and gate CI on the `axe-core` you already ship. `[C12][C13][E19]`
- **Responsive/narrow layouts** — breakpoints; collapse panels gracefully (pop-out + small widths break today). `[UI]`
- **Link hover previews** (title + snippet). `[B24]`
- **Theme preview before apply**; settings search. `[B23][B25]`
- **Calendar drag-to-reschedule + week/day views.** `[C17]`
- **Whole-vault Markdown export** — clean output depends on the **Phase 5** Markdown migration; until then export is lossy from HTML. `[A19]`

---

# PHASE 5 — Data Foundation (Markdown + Sync-Ready Model) 🆕

**Expected Impact: Critical — unblocks Phases 6–8. Effort: Hard.**

**Goal:** Fix the storage and state foundations so sync, export, and AI become possible.

### Includes
- **Migrate note storage HTML → Markdown on disk** (TipTap Markdown serializer; render HTML at view time only). `[E1][S2]`
- **Sync-ready data model:** stable ids, an append-only change log, and tombstones for deletes. `[E7]`
- **Repository storage layer** abstracting SQLite/disk so cloud/sync backends can slot in. `[E12]`
- **Single reactive store** fed by the mutation-ledger change feed → **delete the split-brain reconciler** (root-cause fix for Phase 1's dev-only verifier). `[E2]`
- **Versioned migration framework** (N→N+1 modules, down-migrations) replacing string-in-Rust DDL. `[E4]`
- **Workspace-scoped file layout** (per-workspace subfolders for notes/blobs). `[E14]`
- **Content-addressable attachment store** (dedupe blobs). `[E11]`

### Claude Prompt
> You are implementing Phase 5 of LOOM: the data foundation.
>
> **Objective:** Move from HTML-per-note + multi-source state to a portable, sync-ready foundation, with **no user-facing feature loss**.
>
> **Requirements:**
> 1. Add a TipTap ↔ Markdown serializer; migrate existing `.html` notes to `.md` on disk with a reversible, tested round-trip. Render to HTML only for display.
> 2. Introduce stable item ids (already present), an append-only change log, and soft-delete tombstones, so a future sync engine can diff and merge.
> 3. Put all persistence behind a repository interface; SQLite + local disk is the first implementation.
> 4. Collapse SQLite + React cache + view-memory into one store driven by the change feed; remove SplitBrainVerifier entirely.
> 5. Replace inline DDL with versioned migrations.
>
> **Constraints:** Reversible migration with a backup. No data loss. Round-trip tests for HTML→MD→HTML. Keep the app fully usable at every step.
>
> **Deliver:** Migration report, round-trip test results, rollback procedure, data-model docs/ADRs.

---

# PHASE 6 — Multi-Device & Mobile 🆕

**Expected Impact: Market-expanding. Effort: Hard. Depends on Phase 5.**

### Includes
- **E2E-encrypted sync** of the Markdown vault (file-sync first; CRDT for live edits later). `[A1]`
- **Mobile/web capture client** (PWA or React Native) syncing to the same vault. `[A2]`
- **Offline/sync status UI**; conflict resolution surfaced to the user.
- **Page/note sharing & public export** (read-only first). `[A17]`

### Claude Prompt
> You are implementing Phase 6 of LOOM: multi-device.
>
> **Objective:** Make a user's vault reachable and editable on more than one device without compromising the local-first, private-by-default posture.
>
> **Requirements:**
> 1. End-to-end-encrypted sync of the Markdown vault built in Phase 5 — the server never sees plaintext.
> 2. A capture-first mobile/web client: quick add, search, read; full edit can follow.
> 3. Deterministic conflict resolution (last-writer-wins per file to start; CRDT for paragraph-level later) with a visible "review conflicts" surface.
> 4. Clear sync state in the UI (synced / pending / offline / error).
>
> **Constraints:** No plaintext leaves the device unencrypted. Works offline; syncs when available. No regression to the desktop app.
>
> **Deliver:** Architecture report, threat model, conflict-resolution spec, mobile UX walkthrough.

---

# PHASE 7 — Local AI & Knowledge Intelligence 🆕

**Expected Impact: The competitive wedge. Effort: Medium. Ollama is already wired in.**

### Includes
- **Local embeddings index + semantic search** (fully offline). `[A10]`
- **"Chat with your workspace" — RAG that walks the `links` graph** ("summarize everything connected to this project"). `[A11][F2]`
- **Auditable / undoable AI edits** using the mutation ledger for provenance ("AI did X — undo"). `[F5]`
- **Natural-language automation builder** — local LLM compiles intent to automation rules. `[F24]`
- **"Explain this graph cluster"** with the local model. `[F17]`

### Claude Prompt
> You are implementing Phase 7 of LOOM: local AI over the user's own graph.
>
> **Objective:** Deliver an AI second brain that never phones home — the privacy moat cloud PKMs cannot match.
>
> **Requirements:**
> 1. Build a local embeddings index over notes + indexed file text, updated by the background pipeline (not the DB thread). Semantic search ranks alongside FTS.
> 2. RAG grounded in retrieval that follows the `links` graph (cross-domain: notes, tasks, projects, media), all via the local model (Ollama).
> 3. Every AI mutation is recorded in the mutation ledger with provenance and is undoable.
> 4. Optional: an NL→rules automation builder reusing the (now fixed) automation engine.
>
> **Constraints:** Default fully offline. No data leaves the device. Background indexing must not block the UI or the DB thread.
>
> **Deliver:** Architecture report, retrieval-quality eval, performance/indexing analysis, privacy statement.

---

# PHASE 8 — Extensibility & Ecosystem 🆕

**Expected Impact: Long-term flywheel. Effort: Hard.**

### Includes
- **Plugin / extension API** (sandboxed, capability-scoped). `[A15][E8]`
- **Web clipper** browser extension (strips trackers). `[A12][F22]`
- **Importers:** Notion, Evernote, Roam, Logseq. `[A18]`
- **Labs / feature-flag system**; eventually a privacy-reviewed plugin marketplace. `[E21][F15]`

### Claude Prompt
> You are implementing Phase 8 of LOOM: extensibility.
>
> **Objective:** Let the community extend Loom without compromising local-first privacy or the data model.
>
> **Requirements:**
> 1. A capability-scoped, sandboxed plugin API (read/write items, add views/commands, react to events) — no ambient filesystem/network access.
> 2. A web clipper that captures pages to the vault offline.
> 3. Importers that map external formats onto Loom items + links.
> 4. A feature-flag/Labs system to gate experimental modules (replacing the "Coming soon" dead ends removed in Phase 1).
>
> **Deliver:** Plugin API spec + security model, importer mapping docs, clipper UX, Labs/flag design.

---

# Appendices — Full Backlog (phase-tagged)

Every item from the teardown, with target phase. Items already covered by the
original Phase 1–4 "Includes" are marked **(orig)**.

## A. Top 25 Missing Features

| # | Feature | Impact | Effort | Phase |
|---|---|---|---|---|
|A1|Multi-device sync (E2E, Markdown vault)|Critical|Hard|6|
|A2|Mobile/web capture client|Critical|Hard|6|
|A3|Live `[[wikilink]]` autocomplete → real links|Critical|Medium|3|
|A4|Backlinks panel (linked + unlinked mentions)|High|Medium|3|
|A5|Global + local interactive graph view|High|Medium|3 (orig)|
|A6|Daily notes / journal|High|Easy|2|
|A7|Block references & transclusion/embeds|High|Hard|3|
|A8|Tables, columns, callouts, toggles in editor|High|Medium|3|
|A9|Templates with variables|High|Easy|2|
|A10|Local semantic search (embeddings)|High|Medium|7|
|A11|"Chat with workspace" RAG over the graph|High|Medium|7|
|A12|Web clipper extension|High|Medium|8|
|A13|Custom properties / user-defined fields|High|Medium|3|
|A14|Query blocks (live filtered lists in notes)|High|Medium|3|
|A15|Plugin/extension API|High|Hard|8|
|A16|ICS *subscribe* (two-way)|Medium|Medium|4|
|A17|Page/note sharing & public export|High|Hard|6|
|A18|Importers: Notion, Evernote, Roam, Logseq|Medium|Medium|8|
|A19|Whole-vault Markdown export|Medium|Easy|4/5|
|A20|Tag browser + nested tags|Medium|Easy|2/3 (orig)|
|A21|OCR for images/PDFs (offline)|Medium|Hard|7|
|A22|PDF/EPUB reader + annotation (Library)|Medium|Hard|4|
|A23|Saved searches rendered as live smart-views|Medium|Medium|2 (orig)|
|A24|Kanban/board + timeline/Gantt for Projects|Medium|Medium|2|
|A25|Reminders/notifications engine|Medium|Medium|4 (orig)|

## B. Top 25 Quality-of-Life Improvements

| # | Item | Impact | Effort | Phase |
|---|---|---|---|---|
|B1|Replace `prompt()`/`confirm()` with modals|High|Easy|1|
|B2|Debounced no-op-skip autosave|High|Easy|1|
|B3|Bundle mermaid locally|Medium|Easy|1|
|B4|Real capture modal (drop DOM hack)|Medium|Easy|2|
|B5|`Ctrl+F` find-in-note|Medium|Easy|2|
|B6|Back/forward navigation + view history|Medium|Medium|4|
|B7|Bulk actions (multi-select)|High|Medium|2 (orig)|
|B8|Drag-to-link between items|Medium|Medium|2|
|B9|Pin/favorite + recents surfaced|Medium|Easy|4|
|B10|Keyboard-first item creation everywhere|Medium|Easy|2 (orig)|
|B11|Native date pickers for due dates|Medium|Easy|2|
|B12|Per-note word count/reading time|Low|Easy|4|
|B13|Palette: recent commands + fuzzy ranking|Medium|Easy|2 (orig)|
|B14|Autosave indicator reflects real state|Low|Easy|1|
|B15|Undo/redo for file & automation ops|Medium|Medium|2|
|B16|Trash retention + "empty trash"|Medium|Easy|2|
|B17|Duplicate item / save-as-template|Low|Easy|2|
|B18|Quick-switcher (`Ctrl+O`)|High|Easy|2|
|B19|Per-item color/icon picker|Low|Easy|4|
|B20|Sortable/filterable list columns|Medium|Medium|2|
|B21|"Open in new window" everywhere|Low|Easy|4|
|B22|Reduced-motion; background off by default|Medium|Easy|1|
|B23|Export note to PDF/MD/HTML; theme preview|Low|Easy|4|
|B24|Link hover previews|Medium|Medium|4|
|B25|Settings search|Low|Easy|4|

## C. Top 25 UX Improvements

| # | Item | Impact | Effort | Phase |
|---|---|---|---|---|
|C1|First-run onboarding/tour|High|Medium|4|
|C2|Hide/Labs-gate "Coming soon" modules|Medium|Easy|1/8|
|C3|Selection bubble menu in editor|Medium|Medium|3|
|C4|Real local-graph w/ depth & filters|High|Medium|3 (orig)|
|C5|Inbox/Today as default capture target|High|Easy|2|
|C6|Consistent empty states w/ first action|Medium|Easy|4 (orig)|
|C7|Saved searches as pinned smart-lists|Medium|Medium|2 (orig)|
|C8|Deep-linkable items + back/forward|Medium|Medium|4|
|C9|Unified create flow (`+` → type picker)|Medium|Easy|2|
|C10|Toolbar grouping + overflow|Medium|Easy|3|
|C11|Breadcrumbs reflecting note→project|Medium|Medium|4 (orig)|
|C12|Focus traps in modals & palette|High|Medium|4|
|C13|Non-color status indicators (a11y)|High|Medium|4|
|C14|Dockable inspector (less panel hijack)|Medium|Medium|4|
|C15|Drag-drop reordering in lists/boards|Medium|Medium|2|
|C16|Backlinks inline at bottom of note|High|Medium|3|
|C17|Calendar drag-reschedule, week/day views|Medium|Medium|4|
|C18|Natural-language due dates|Medium|Medium|2|
|C19|"Recently edited" + "frequently visited"|Medium|Easy|1/2|
|C20|Clear sync/offline status|Medium|Medium|6|
|C21|Consistent right-click context menus|Medium|Medium|2|
|C22|Inline error-recovery toasts w/ actions|Low|Easy|4 (orig)|
|C23|Theme preview before apply|Low|Easy|4|
|C24|Density/zoom that reflows content|Low|Medium|4|
|C25|Onboarding checklist that auto-dismisses|Low|Easy|4|

## D. Top 25 Performance Improvements

| # | Item | Impact | Effort | Phase |
|---|---|---|---|---|
|D1|Delta-integrity vs full scan ×2 per write|High|Hard|1 (orig)|
|D2|Event-driven/idle integrity sweep|High|Easy|1|
|D3|File I/O off the DB thread (`index_text_files`)|High|Medium|1|
|D4|Incremental store via change feed|High|Medium|1|
|D5|Windowed/paged item store|High|Medium|1 (orig)|
|D6|Debounced no-op-skip autosave|Medium|Easy|1|
|D7|Bundle mermaid; remove CDN fetch|Medium|Easy|1|
|D8|Partial indexes (done) + verify query plans|Medium|Easy|1|
|D9|Code-split Modules/Modules2 (lazy load)|Medium|Medium|1|
|D10|Memoize adjacency/graph; rebuild on delta|Medium|Medium|3|
|D11|Finish virtualizing all long lists|Medium|Medium|1 (orig)|
|D12|Cache rendered note HTML; skip re-parse|Medium|Medium|1|
|D13|Throttle/remove mousemove parallax|Low|Easy|1|
|D14|Batch FTS updates on bulk import|Medium|Medium|1|
|D15|WAL autocheckpoint tuning + periodic checkpoint|Low|Easy|1|
|D16|Stream encrypt/decrypt (no full-file read)|Medium|Medium|5|
|D17|Defer non-critical startup work post-paint|Medium|Medium|1|
|D18|Avoid full reload on window focus|Medium|Medium|1|
|D19|Verify links index covers both endpoints|Low|Easy|1|
|D20|Cap/compress `full_text` in metadata|Low|Easy|1|
|D21|Web Worker for graph layout|Medium|Medium|3|
|D22|Prune ledger (done) + periodic VACUUM on idle|Low|Easy|1|
|D23|Reduce re-renders from `force()` on selection|Low|Medium|3|
|D24|Skeletons instead of blocking spinners|Low|Easy|4|
|D25|Perf budget in CI via `scale_perf.rs`|Medium|Medium|1|

## E. Top 25 Architectural Improvements

| # | Item | Impact | Effort | Phase |
|---|---|---|---|---|
|E1|Note storage HTML→Markdown|Critical|Hard|5|
|E2|Single reactive store; delete reconciler|High|Hard|5|
|E3|Demote per-write global integrity to background|High|Hard|1|
|E4|Versioned migration framework|Medium|Medium|5|
|E5|Structured error types (`thiserror`)|Medium|Medium|1|
|E6|Split Modules/Modules2 per module|Medium|Medium|1|
|E7|Sync-ready model (ids, change log, tombstones)|High|Hard|5|
|E8|Plugin API boundary (sandboxed)|High|Hard|8|
|E9|Fix automation SAVEPOINT reentry|High|Medium|1 (orig)|
|E10|Internal event bus (replace DOM/CustomEvent hacks)|Medium|Medium|1|
|E11|Content-addressable attachment store|Medium|Medium|5|
|E12|Repository storage layer (enables sync)|High|Hard|5|
|E13|Stream large-file crypto (chunked)|Medium|Medium|5|
|E14|Workspace-scoped file layout|Medium|Medium|5|
|E15|Background indexing pipeline (FTS+embeddings)|High|Medium|7|
|E16|Typed IPC contract (shared TS↔Rust schema)|Medium|Medium|1|
|E17|Property/schema system for item types|Medium|Hard|3|
|E18|Module-UI test coverage|Medium|Medium|1|
|E19|CI: cargo test + vitest + axe + perf gates|Medium|Medium|1|
|E20|Opt-in local crash/diagnostics log|Low|Easy|1|
|E21|Feature-flag/Labs system|Low|Easy|8|
|E22|Centralize theme tokens; kill inline styles|Medium|Medium|4|
|E23|Export/import round-trip tests|Medium|Medium|5|
|E24|Cron-like scheduler (vs fixed 30s loop)|Low|Medium|1|
|E25|Data-model docs + ADRs|Low|Easy|5|

## F. Top 25 Competitive Advantages to Build

| # | Advantage | Effort | Phase |
|---|---|---|---|
|F1|Fully-offline local AI (RAG over your graph)|Medium|7|
|F2|Cross-domain graph + queries (tasks↔notes↔habits↔media)|Medium|3/7|
|F3|Life automation engine (knowledge+execution triggers)|Medium|1/2|
|F4|E2E-encrypted sync of a plain-Markdown vault|Hard|6|
|F5|Auditable/undoable AI edits (ledger provenance)|Medium|7|
|F6|Time-machine: navigate the brain by date|Medium|3|
|F7|Local OCR + semantic image/PDF search|Hard|7|
|F8|Encrypted Vault as a first-class linked node|Medium|3|
|F9|Deterministic crash-safe local store (built — market it)|Done|—|
|F10|Theme/CSS power-user customization (strong)|Easy|4|
|F11|One-keystroke OS-wide capture to Today|Medium|2/6|
|F12|Project = live rollup of linked items|Medium|2/3|
|F13|Habit+calendar+task fusion (run your day from notes)|Medium|2/4|
|F14|Local model choice (Ollama) per task|Easy|7|
|F15|Privacy-reviewed plugin marketplace|Hard|8|
|F16|Graph-aware search ranking|Medium|3|
|F17|"Explain this graph cluster" (local AI)|Medium|7|
|F18|Bidirectional ICS + read-it-later inbox|Medium|4|
|F19|Versioned note history (git-like, local)|Medium|5|
|F20|Named workspace snapshots/"save states" (expose better)|Easy|3|
|F21|Smart templates that pre-link|Medium|2|
|F22|Tracker-stripping offline web clipper|Medium|8|
|F23|Per-workspace encryption profiles|Medium|5/6|
|F24|NL automation builder (local LLM → rules)|Medium|7|
|F25|"Second brain health" dashboard|Easy|3|

## G. Top 10 to Remove / Simplify / Redesign

| # | Target | Action | Phase |
|---|---|---|---|
|G1|Per-write double `verify_integrity_all`|Redesign → delta/background|1|
|G2|30s filesystem+DB integrity sweep|Simplify → event-driven/idle|1|
|G3|Notes-as-HTML|Redesign → Markdown|5|
|G4|`prompt()`/`confirm()` flows|Replace → modals|1|
|G5|"Coming soon" greyed nav items|Remove / Labs-gate|1/8|
|G6|DOM-typing quick-capture hack|Redesign → real modal|2|
|G7|Split-brain verifier / multi-source state|Simplify → one store + change feed|5|
|G8|`Modules.tsx` + `Modules2.tsx` mega-files|Refactor per module|1|
|G9|Ambient/parallax/acrylic background engine|Simplify, default off|1|
|G10|Mermaid-from-CDN|Replace → bundled|1|

## H. Prioritized Roadmap (ROI: high impact / low effort first)

**Phase 0 — Stop the bleeding (days, mostly Easy, high impact).** Fold into the
start of Phase 1.
1. Event-driven/idle integrity sweep + widen scheduler `[D2/G2]`.
2. Replace `prompt()`/`confirm()` with modals `[B1/G4]`; debounced no-op autosave `[B2]`.
3. Bundle mermaid `[D7/G10]`; background off + reduced-motion `[B22]`.
4. Hide "Coming soon" modules `[C2/G5]`; Quick-switcher `Ctrl+O` `[B18]`; find-in-note `[B5]`.
5. **Fix the automation SAVEPOINT bug** `[E9]` — unlocks the whole automation pillar cheaply.

**Phase 1 — Reliability & Scalability** (original Phase 1 + its ➕ additions).

**Phase 2 — Productivity** (original Phase 2 + daily notes, templates, quick-switcher).

**Phase 3 — Knowledge graph** (original Phase 3 + live `[[ ]]`, backlinks, block refs).

**Phase 4 — Polish** (original Phase 4 + a11y teeth, ICS subscribe, responsiveness).

**Phase 5 — Data foundation** (Markdown + sync-ready model). *Gate to everything below.*

**Phase 6 — Sync & mobile.**

**Phase 7 — Local AI** (the wedge; Ollama already wired).

**Phase 8 — Extensibility** (plugins, clipper, importers).

**Sequencing logic:** Phase 0 is pure ROI and removes the worst perf/UX/credibility
drags. Phases 1–4 make Loom a credible, polished PKM. Phase 5's Markdown+sync-ready
foundation is the gate to market-expanding work. Phases 6–8 are where Loom stops
matching competitors and starts winning — local-AI-over-your-own-graph is the one
thing no cloud incumbent can copy without abandoning their business model.

---

### Notes & caveats
- Interiors of `Modules.tsx` / `Modules2.tsx` were not read line-by-line; some
  Tasks/Projects/Calendar features may be deeper than credited here.
- Competitor benchmarking assumed the category leaders (Notion, Obsidian, Logseq,
  Roam, Anytype/Tana, Evernote); adjust if a different set was intended.
- Security/reliability fixes already landed in a prior session (CSP, fs path guard,
  workspace link boundary, DB corruption recovery, ledger sweep, migration guard,
  greet removal, Playwright prune) — Phase 1's overlap with those is intentional;
  treat them as done where noted.
