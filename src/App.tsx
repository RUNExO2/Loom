import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { pageVariants, springBase } from "./lib/motionVariants";
import { LoomCtx, I, cx } from "./lib/context";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useItemStore } from "./lib/itemStore";
import { useCommands } from "./lib/commands";
import { makeActionsApi, ActionsCtx } from "./lib/actions";
import { buildNav } from "./lib/stats";
import {
  getThemePref, setThemePref as persistThemePref, resolveTheme, applyResolvedTheme, themeFamily,
  getAccentPref, setAccentPref as persistAccentPref, applyAccent,
  getStartupView, SHORTCUTS, ThemePref, Resolved,
  getFontPref, applyFont, getDensityPref, applyDensity, getAmbientPref, applyAmbient,
  getAcrylicPref, applyAcrylic, getNavStylePref, setNavStylePref, applyNavStyle, NavStyle,
  getBackgroundConfig, applyBackgroundConfig,
} from "./lib/settings";
import { trackItemOpened } from "./lib/viewMemory";
import { getCustomThemeState, applyCustomTheme, activeTheme, reloadCustomCss } from "./lib/theme";
import { ConnectionsPanel, Toasts, ShortcutsOverlay } from "./components/shared";
import { fsImportNoteFile, fsImportFile } from "./ipc/fs";
import { Dashboard } from "./components/Dashboard";
import { NotesModule, TimelineModule, LibraryModule, VaultModule, AutomationModule } from "./components/Modules";
import { TasksModule, ProjectsModule, HabitsModule, CalendarModule, BookmarksModule, FilesModule } from "./components/Modules2";
import { SettingsModule } from "./components/Settings";
import { CommandPalette } from "./components/CommandPalette";
import { SplitBrainVerifier } from "./lib/splitBrainVerifier";
import { TopNav } from "./components/TopNav";

type View = "dashboard" | "notes" | "timeline" | "library" | "tasks" | "projects" | "habits" | "calendar" | "vault" | "bookmarks" | "files" | "automation" | "settings";

interface ToastAction { label: string; onClick: () => void; }
type ToastKind = "success" | "error" | "warning" | "info";
interface Toast { id: string; msg: string; icon?: string; kind?: ToastKind; duration?: number; action?: ToastAction; }

let toastId = 0;

const getDragIcon = (view: string): string => {
  switch (view) {
    case "notes": return "ph-note-pencil";
    case "files": return "ph-file-plus";
    case "library": return "ph-image";
    case "bookmarks": return "ph-bookmark-simple";
    default: return "ph-file-arrow-down";
  }
};

const getDragTitle = (view: string): string => {
  switch (view) {
    case "notes": return "Import to Notes";
    case "files": return "Import to Files";
    case "library": return "Set Cover Image";
    case "bookmarks": return "Import to Bookmarks";
    default: return "Import as File";
  }
};

const getDragSub = (view: string): string => {
  switch (view) {
    case "notes": return "Drop text, markdown, or Word files to import as notes. Drop other files to attach.";
    case "files": return "Drop files to copy them into Loom or save reference links.";
    case "library": return "Drop a JPG or PNG onto any library item to set its cover image.";
    case "bookmarks": return "Drop web shortcuts (.url, .webloc) or text files containing links to import.";
    default: return "Drop files to add them to your files subsystem.";
  }
};

// Views that run their own loom-file-drop handler while mounted.
const DROP_AWARE_VIEWS = new Set(["notes", "files", "library", "bookmarks"]);
const NOTE_EXTS = new Set(["txt", "md", "markdown", "rtf", "docx", "html"]);

export function App() {
  const { resolve, refresh, items, workspaceId, create } = useItemStore();
  const { undo, redo, canUndo, canRedo, undoLabel, redoLabel } = useCommands();
  // buildNav re-filters every item several times; memoize so it only recomputes when
  // the item set actually changes, not on every unrelated App re-render.
  const navGroups = useMemo(() => buildNav(items), [items]);
  // Pop-out windows open with ?view=&focus= so a new native window lands on the right
  // module and item (used by note + connections pop-out buttons).
  const initialParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const initialView = (initialParams?.get("view") as View | null) || "dashboard";
  const initialFocus = initialParams?.get("focus") || null;
  const [view, setView] = useState<View>(initialView);
  const [focusId, setFocusId] = useState<string | null>(initialFocus);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [themePref, setThemePrefState] = useState<ThemePref>("dark");
  const [resolved, setResolved] = useState<Resolved>("dark");
  const [accent, setAccentState] = useState<string>("violet");
  const [dashEditing, setDashEditing] = useState(false);
  const [ready, setReady] = useState(false);
  const [dragTargetId, setDragTargetId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [navStyle, setNavStyleState] = useState<NavStyle>("sidebar");
  const [searchExpanded, setSearchExpanded] = useState(false);

  // Global drag-and-drop window listener
  useEffect(() => {
    let unlisten: any;
    try {
      getCurrentWindow().onDragDropEvent((event) => {
        if ((window as any).__loomInternalDrag) {
          setDragOver(false);
          return;
        }
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          setDragOver(true);
        } else if (event.payload.type === 'leave') {
          setDragOver(false);
        } else if (event.payload.type === 'drop') {
          setDragOver(false);
          const paths = event.payload.paths;
          if (paths && paths.length > 0) {
            const dropEvent = new CustomEvent("loom-file-drop", { detail: { paths } });
            window.dispatchEvent(dropEvent);
          }
        }
      }).then(u => unlisten = u).catch(console.error);
    } catch (e) {
      console.warn("Tauri drag-and-drop not available in this environment:", e);
    }

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Load startup settings once on mount
  useEffect(() => {
    Promise.all([
      getStartupView(), getThemePref(), getAccentPref(),
      getFontPref(), getDensityPref(), getAmbientPref(),
      getAcrylicPref(), getNavStylePref(), getBackgroundConfig()
    ]).then(([startup, theme, acc, font, density, ambient, acrylic, navSt, bgConf]) => {
      // A pop-out window carries ?view= — honour it over the configured startup view.
      if (!initialParams?.get("view")) setView(startup as View);
      setThemePrefState(theme as string);
      setAccentState(acc as string);
      applyFont(font as string);
      applyDensity(density as any);
      applyAmbient(ambient as boolean);
      applyAcrylic(acrylic as boolean);
      applyNavStyle(navSt as NavStyle);
      setNavStyleState(navSt as NavStyle);
      applyBackgroundConfig(bgConf as any);
      setReady(true);
    });
    // Apply the saved custom theme (design-token overrides) on launch, if enabled.
    getCustomThemeState().then((st) => applyCustomTheme(activeTheme(st), st.enabled));
    // Inject user CSS from the Custom CSS folder, and live-reload it whenever the window
    // regains focus so external edits show up without a restart.
    reloadCustomCss();
    const onFocus = () => { reloadCustomCss(); };
    window.addEventListener("focus", onFocus);

    // Global Parallax listener
    const onMove = (e: MouseEvent) => {
      if (document.documentElement.dataset.parallax !== "on") return;
      // Calculate slight offset relative to center (e.g. max 15px shift)
      const x = (e.clientX / window.innerWidth - 0.5) * 30;
      const y = (e.clientY / window.innerHeight - 0.5) * 30;
      document.documentElement.style.setProperty("--bg-px", `${x}px`);
      document.documentElement.style.setProperty("--bg-py", `${y}px`);
    };
    window.addEventListener("mousemove", onMove, { passive: true });

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Resolve + apply theme; persist the preference; track the OS scheme when "system".
  useEffect(() => {
    if (!ready) return;
    persistThemePref(themePref);
    const apply = () => { const r = resolveTheme(themePref); setResolved(r); applyResolvedTheme(r); };
    apply();
    if (themePref === "system" && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [themePref, ready]);

  // Apply + persist the accent hue.
  useEffect(() => {
    if (!ready) return;
    applyAccent(accent);
    persistAccentPref(accent);
  }, [accent, ready]);

  // Global shortcut handler — bindings come from the canonical SHORTCUTS list.
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      // "?" opens the shortcuts reference (ignored while typing in a field).
      if (e.key === "?" && !isTyping()) { e.preventDefault(); setShortcutsOpen((s) => !s); return; }
      for (const sc of SHORTCUTS) {
        if (!sc.test(e)) continue;
        if (sc.id === "palette") { e.preventDefault(); setPalette((p) => !p); }
        // Quick-switcher reuses the palette (recents + fuzzy item jump); just opens it.
        else if (sc.id === "quickswitch") { e.preventDefault(); setPalette(true); }
        else if (sc.id === "close") { setPalette(false); setInspectId(null); setShortcutsOpen(false); }
        // Inside a text field, let the browser's native text undo/redo win.
        else if (sc.id === "undo") { if (isTyping()) return; e.preventDefault(); undo(); }
        else if (sc.id === "redo") { if (isTyping()) return; e.preventDefault(); redo(); }
      }
      
      // Quick Capture hotkey — opens the command palette pre-seeded with "Capture: ".
      if (e.ctrlKey && e.shiftKey && e.code === "Space") {
        e.preventDefault();
        setPalette(true);
        // Wait a tick for the palette input to mount, then seed it.
        setTimeout(() => {
          const input = document.querySelector('.cmd-in input') as HTMLInputElement;
          if (input) {
            input.value = "Capture: ";
            // Simulate triggering the React onChange by dispatching event
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, "Capture: ");
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }, 50);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const toast = useCallback((msg: string, icon?: string, action?: ToastAction, kind?: ToastKind) => {
    const id = String(++toastId);
    // Undo toasts linger longer so the action is reachable.
    const duration = action ? 6000 : 2800;
    setToasts((t) => [...t, { id, msg, icon, action, kind, duration }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), duration);
  }, []);

  const navigate = useCallback((v: string) => {
    setView(v as View);
    setInspectId(null);
  }, []);

  // Global drop fallback — when the active view has no drop handler of its own,
  // documents become notes (and we jump there); everything else lands in Files.
  useEffect(() => {
    if (DROP_AWARE_VIEWS.has(view) || !workspaceId) return;
    const onDrop = async (e: Event) => {
      const paths: string[] = (e as CustomEvent).detail?.paths || [];
      let importedNote = false;
      for (const p of paths) {
        const ext = p.split(".").pop()?.toLowerCase() || "";
        try {
          if (NOTE_EXTS.has(ext)) {
            await fsImportNoteFile(workspaceId, p);
            importedNote = true;
          } else {
            await fsImportFile(workspaceId, p, "copy");
          }
        } catch (err) {
          console.error("Global drop import failed:", err);
          toast("Import failed for one file.", "ph-warning", undefined, "error");
        }
      }
      await refresh();
      if (importedNote) {
        setView("notes");
        toast("Document imported as note", "ph-note", undefined, "success");
      } else if (paths.length) {
        toast("File imported to Files", "ph-file-plus", undefined, "success");
      }
    };
    window.addEventListener("loom-file-drop", onDrop);
    return () => window.removeEventListener("loom-file-drop", onDrop);
  }, [view, workspaceId, refresh, toast]);

  // Periodical Integrity Sweep
  useEffect(() => {
    if (!ready || !workspaceId) return;

    const runSweep = async () => {
      try {
        const result: any = await invoke("run_integrity_sweep");
        if (result && result.issues_detected && result.issues_detected.length > 0) {
          console.warn("Integrity issues detected during sweep:", result.issues_detected);
          if (result.repairs_taken && result.repairs_taken.length > 0) {
            toast(`System repaired: ${result.repairs_taken.join(", ")}`, "ph-wrench", undefined, "info");
            await refresh(); // reload store state if anything was auto-repaired
          }
        }
      } catch (err) {
        console.error("Integrity sweep failed:", err);
      }
    };

    // ponytail: idle/visibility-gated poll, not event-driven. A true post-mutation
    // sweep (fire only on writes) is the upgrade if this still shows on a profiler.
    // Skip while the window is hidden — the local DB can't change with no one driving it.
    const tick = () => { if (document.visibilityState === "visible") runSweep(); };
    const initialTimeout = setTimeout(tick, 5000);
    const interval = setInterval(tick, 120 * 1000);
    // Catch up once when the user comes back to a previously-hidden window.
    const onVisible = () => { if (document.visibilityState === "visible") runSweep(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, workspaceId, refresh, toast]);

  const inspect = useCallback(async (id: string) => {
    // Resolve identity from the SQLite-backed runtime store (never the seed dataset).
    let e = resolve(id);
    if (!e) { await refresh(); e = resolve(id); } // freshly-created item not yet in snapshot
    if (!e) return;
    const typeToView: Record<string, View> = {
      note: "notes", task: "tasks", project: "projects",
      library: "library", media: "library", file: "files", bookmark: "bookmarks",
      habit: "habits", calendar: "calendar", vault: "vault", automation: "automation",
    };
    const target = typeToView[e.type];
    if (target) setView(target);
    setFocusId(id);
    setInspectId(id);
    trackItemOpened(id);
  }, [resolve, refresh]);

  const openPalette = useCallback(() => setPalette(true), []);
  const editDash = useCallback(() => { setDashEditing(true); setView("dashboard"); }, []);
  const setTheme = useCallback((p: ThemePref) => setThemePrefState(p), []);
  // Toggle flips between light and the most recent dark-family theme.
  const lastDarkRef = useRef<string>("dark");
  useEffect(() => { if (themeFamily(resolved) === "dark") lastDarkRef.current = resolved; }, [resolved]);
  const toggleTheme = useCallback(
    () => setThemePrefState(themeFamily(resolved) === "dark" ? "light" : lastDarkRef.current),
    [resolved]
  );
  const setAccent = useCallback((a: string) => setAccentState(a), []);

  const showShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const setNavStyle = useCallback(async (style: NavStyle) => {
    await setNavStylePref(style);
    setNavStyleState(style);
    applyNavStyle(style);
  }, []);
  const ctx = { navigate, inspect, toast, openPalette, editDash, showShortcuts, toggleTheme, themePref, setTheme, accent, setAccent, dragTargetId, setDragTargetId, navStyle, setNavStyle };

  // The single action registry — built once from the app's real mutators/navigation
  // and provided so the palette, keyboard, and automation all dispatch through it.
  const actionsApi = useMemo(
    () => makeActionsApi({ 
      create, navigate, inspect, toast, editDash, showShortcuts, toggleTheme,
      setNavStyle,
      setDensity: (mode) => {
        applyDensity(mode);
        import("./lib/settings").then(s => s.setDensityPref(mode));
      }
    }),
    [create, navigate, inspect, toast, editDash, showShortcuts, toggleTheme, setNavStyle],
  );

  if (!ready) return null;

  const crumb = view.charAt(0).toUpperCase() + view.slice(1);

  return (
    <LoomCtx.Provider value={ctx}>
      <ActionsCtx.Provider value={actionsApi}>
      <div className="app" data-theme={resolved}>
        {/* Background Engine Layer */}
        <div id="loom-bg-engine" />
        
        {dragOver && (
          <div className="global-drag-overlay">
            <div className="drag-content">
              <I n={getDragIcon(view)} w="bold" style={{ fontSize: 60, color: "var(--accent)" }} />
              <h2>{getDragTitle(view)}</h2>
              <p>{getDragSub(view)}</p>
            </div>
          </div>
        )}
        <a className="skip-link" href="#main-content">Skip to main content</a>
        {/* ---- Titlebar ---- */}
        <header className="titlebar" data-tauri-drag-region>
          <div className="tb-left">
            <div className="tb-logo" role="img" aria-label="LOOM">
              <img src="/icon.png" alt="" aria-hidden draggable={false} />
            </div>
            <span className="tb-title">LOOM</span>
            <div className="tb-sep"></div>
            <span className="tb-crumb"><I n="ph-house" style={{ fontSize: "var(--fs-xs)" }} /> {crumb}</span>
          </div>

          <div className="tb-drag" data-tauri-drag-region>
            {navStyle === "top-pill" ? (
              <TopNav navGroups={navGroups} view={view} navigate={navigate} toast={toast} />
            ) : (
              <button className="tb-search" onClick={() => setPalette(true)} id="open-palette-btn">
                <I n="ph-magnifying-glass" />
                <span>Search everything…</span>
                <span className="kbd">⌘K</span>
              </button>
            )}
          </div>

          <div className="tb-actions">
            {navStyle === "top-pill" && (
              <div className={cx("tb-search-exp", searchExpanded && "expanded")}>
                <button 
                  className={cx("tb-iconbtn", searchExpanded && "active")} 
                  onClick={() => {
                    if (searchExpanded) setPalette(true);
                    else setSearchExpanded(true);
                  }}
                  onBlur={(e) => {
                    // close if focus leaves the expanding container
                    if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) {
                      setSearchExpanded(false);
                    }
                  }}
                  title="Search everything... (⌘K)"
                  aria-label="Search"
                >
                  <I n="ph-magnifying-glass" />
                </button>
                {searchExpanded && (
                  <button className="tb-search-inner" onClick={() => setPalette(true)}>
                    <span>Search everything…</span>
                    <span className="kbd">⌘K</span>
                  </button>
                )}
              </div>
            )}
            
            <button className="tb-iconbtn" onClick={() => undo()} disabled={!canUndo} title={canUndo ? `Undo ${undoLabel}` : "Nothing to undo"} aria-label={canUndo ? `Undo ${undoLabel}` : "Nothing to undo"} id="undo-btn">
              <I n="ph-arrow-counter-clockwise" />
            </button>
            <button className="tb-iconbtn" onClick={() => redo()} disabled={!canRedo} title={canRedo ? `Redo ${redoLabel}` : "Nothing to redo"} aria-label={canRedo ? `Redo ${redoLabel}` : "Nothing to redo"} id="redo-btn">
              <I n="ph-arrow-clockwise" />
            </button>
            <button className="tb-iconbtn" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme" id="toggle-theme-btn">
              <I n={themeFamily(resolved) === "dark" ? "ph-sun" : "ph-moon"} />
            </button>
            <button className="tb-iconbtn" onClick={() => navigate("settings")} title="Settings" aria-label="Open settings" id="open-settings-btn">
              <I n="ph-gear-six" />
            </button>
            <button className="tb-iconbtn" onClick={() => setSidebarCollapsed((c) => !c)} title="Toggle sidebar" aria-label="Toggle sidebar" aria-expanded={!sidebarCollapsed} id="toggle-sidebar-btn">
              <I n="ph-sidebar-simple" />
            </button>
          </div>

        </header>

        {/* ---- Body ---- */}
        <div className="body-row">
          {/* Sidebar — rendered when navStyle === "sidebar" */}
          {navStyle === "sidebar" && (
          <nav
            className={cx("sidebar", sidebarCollapsed && "collapsed")}
            aria-label="Main navigation"
            onKeyDown={(e) => {
              // Arrow keys move focus between nav items (wraps at the ends).
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              const els = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".nav-item"));
              const idx = els.indexOf(document.activeElement as HTMLButtonElement);
              if (idx === -1) return;
              e.preventDefault();
              els[(idx + (e.key === "ArrowDown" ? 1 : els.length - 1)) % els.length]?.focus();
            }}
          >
            <div className="side-head">
              <div className="side-brand-ico"><img src="/icon.png" alt="LOOM" draggable={false} /></div>
              {!sidebarCollapsed && (
                <div className="side-brand-tx">
                  <div className="nm">LOOM</div>
                  <div className="sub">Life OS</div>
                </div>
              )}
            </div>

            <div className="side-scroll">
              {navGroups.map((group) => (
                <div key={group.group}>
                  <div className="nav-group-title">{group.group}</div>
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      id={`nav-${item.id}`}
                      className={cx("nav-item", view === item.id && "active", item.soon && "soon")}
                      style={{ "--mod": item.mod } as any}
                      onClick={() => item.soon
                        ? toast(`${item.label} is coming soon.`, "ph-hourglass-medium", undefined, "info")
                        : navigate(item.id)}
                      title={item.soon ? `${item.label} — coming soon` : sidebarCollapsed ? item.label : undefined}
                      aria-disabled={item.soon || undefined}
                    >
                      {view === item.id && (
                        <motion.span layoutId="nav-active-ind" className="nav-ind" transition={springBase} aria-hidden />
                      )}
                      <span className="nav-ico"><I n={item.icon} w={view === item.id ? "fill" : "regular"} /></span>
                      <span className="nav-label">{item.label}</span>
                      {item.soon ? (
                        <span className="nav-soon">Soon</span>
                      ) : (
                        <>
                          {item.badgeValue != null && item.badgeValue > 0 && (
                            <span className="nav-badge">{item.badgeValue}</span>
                          )}
                          {item.dot && <span className="nav-badge dot"></span>}
                        </>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>

          </nav>
          )}


          {/* Main */}
          <main className="main" id="main-content" tabIndex={-1}>
            <div className="content">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={view} variants={pageVariants} initial="initial" animate="enter" exit="exit">
                  <PageRouter view={view} focusId={focusId} dashEditing={dashEditing} setDashEditing={setDashEditing} />
                </motion.div>
              </AnimatePresence>
            </div>
          </main>

          {/* Connections panel */}
          {inspectId && (
            <ConnectionsPanel id={inspectId} onClose={() => setInspectId(null)} />
          )}
        </div>

        {/* Overlays */}
        <AnimatePresence>
          {palette && <CommandPalette key="palette" onClose={() => setPalette(false)} />}
        </AnimatePresence>
        <AnimatePresence>
          {shortcutsOpen && <ShortcutsOverlay key="shortcuts" onClose={() => setShortcutsOpen(false)} />}
        </AnimatePresence>
        <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
        <SplitBrainVerifier />
      </div>
      </ActionsCtx.Provider>
    </LoomCtx.Provider>
  );
}

function PageRouter({ view, focusId, dashEditing, setDashEditing }: {
  view: View; focusId: string | null; dashEditing: boolean; setDashEditing: (v: boolean) => void;
}) {
  switch (view) {
    case "dashboard": return <Dashboard editing={dashEditing} setEditing={setDashEditing} />;
    case "notes": return <NotesModule focusId={focusId} />;
    case "timeline": return <TimelineModule />;
    case "library": return <LibraryModule />;
    case "tasks": return <TasksModule />;
    case "projects": return <ProjectsModule />;
    case "habits": return <HabitsModule />;
    case "calendar": return <CalendarModule />;
    case "vault": return <VaultModule />;
    case "bookmarks": return <BookmarksModule />;
    case "files": return <FilesModule />;
    case "automation": return <AutomationModule />;
    case "settings": return <SettingsModule />;
    default: return <Dashboard editing={false} setEditing={() => {}} />;
  }
}
