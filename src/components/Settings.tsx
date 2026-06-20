import { useState, useEffect } from "react";
import { I, cx, useLoom } from "../lib/context";
import {
  getStartupView, setStartupView, STARTUP_VIEWS, SHORTCUTS, THEMES, ACCENTS,
  FONTS, getFontPref, setFontPref, applyFont,
  getDensityPref, setDensityPref, applyDensity,
  getAmbientPref, setAmbientPref, applyAmbient,
  getAcrylicPref, setAcrylicPref, applyAcrylic,
  NavStyle,
} from "../lib/settings";
import { useItemStore } from "../lib/itemStore";
import { defaultDashboardLayout } from "./Dashboard";
import { optimizeDatabase, importNotesFromFolder, importObsidianVault, revealCustomCssFolder } from "../ipc/content";
import { reloadCustomCss } from "../lib/theme";
import { WORKSPACE_TEMPLATES, applyWorkspaceTemplate } from "../lib/templates";
import { open, save } from "@tauri-apps/plugin-dialog";
import { exportData, backupDatabase, importData, clearAllUserData } from "../ipc/settings";
import { exportWorkspaceArchive, importWorkspaceArchive } from "../ipc/workspaces";
import { useModal } from "./Modal";
import { mutationEngine } from "../lib/mutationEngine";
import { Button } from "./ui/Button";
import { ThemeStudio } from "./ThemeStudio";
import { RecoveryPanel } from "./RecoveryPanel";
import { AnimatePresence } from "framer-motion";
import * as Switch from "@radix-ui/react-switch";

function Section({ icon, title, sub, danger, children }: { icon: string; title: string; sub: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 30, maxWidth: 760 }}>
      <div className="row gap12" style={{ marginBottom: 4 }}>
        <div className="vault-ico" style={{ "--mod": danger ? "var(--danger)" : "var(--accent)", width: 32, height: 32 } as any}><I n={icon} w="fill" /></div>
        <div>
          <div style={{ fontWeight: 600, fontSize: "var(--fs-lg)", color: danger ? "var(--danger-text)" : undefined }}>{title}</div>
          <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>{sub}</div>
        </div>
      </div>
      <div className={cx(danger && "danger-zone-box")} style={{ background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 16, marginTop: 12 }}>
        {children}
      </div>
    </section>
  );
}

export function SettingsModule() {
  const { toast, themePref, setTheme, accent, setAccent, navStyle, setNavStyle } = useLoom();
  const modal = useModal();
  const { workspaceId, saveDashboard, refresh } = useItemStore();
  const [startup, setStartup] = useState<string>("dashboard");
  const [busy, setBusy] = useState<string | null>(null);
  const [font, setFont] = useState<string>("inter");
  const [density, setDensity] = useState<string>("comfortable");
  const [ambient, setAmbient] = useState<boolean>(false);
  const [acrylic, setAcrylicState] = useState<boolean>(false);
  const [themeStudio, setThemeStudio] = useState(false);

  useEffect(() => {
    getStartupView().then(setStartup);
    getFontPref().then(setFont);
    getDensityPref().then(setDensity);
    getAmbientPref().then(setAmbient);
    getAcrylicPref().then(setAcrylicState);
  }, []);

  const chooseFont = (id: string) => {
    setFont(id); applyFont(id); setFontPref(id);
    toast(`Font: ${FONTS.find((f) => f.id === id)?.label ?? id}`, "ph-text-aa");
  };
  const chooseDensity = (mode: import("../lib/settings").DensityMode) => {
    setDensity(mode); applyDensity(mode); setDensityPref(mode);
  };
  const toggleAmbient = (on: boolean) => {
    setAmbient(on); applyAmbient(on); setAmbientPref(on);
  };
  const toggleAcrylic = (on: boolean) => {
    setAcrylicState(on); applyAcrylic(on); setAcrylicPref(on);
    toast(on ? "Acrylic mode enabled" : "Acrylic mode disabled", "ph-drop-half");
  };
  const chooseNavStyle = (style: NavStyle) => {
    setNavStyle(style);
    toast(style === "top-pill" ? "Switched to top pill navigation" : "Switched to sidebar navigation", "ph-list");
  };

  const onOptimizeDb = async () => {
    setBusy("optimize");
    try {
      const freed = await optimizeDatabase();
      const mb = (freed / (1024 * 1024));
      toast(freed > 0 ? `Database optimized — freed ${mb.toFixed(1)} MB` : "Database optimized", "ph-broom");
    } catch (e) {
      console.error("Optimize failed:", e);
      toast("Database optimization failed", "ph-warning");
    } finally { setBusy(null); }
  };

  const onImportFolder = async (label: string) => {
    if (!workspaceId) return;
    const dir = await open({ directory: true, multiple: false, title: `Select ${label} folder` });
    if (!dir || Array.isArray(dir)) return;
    setBusy("import");
    try {
      const res = await importNotesFromFolder(workspaceId, dir);
      await refresh();
      toast(`Imported ${res.imported} note(s) from ${label}${res.skipped ? ` · ${res.skipped} skipped` : ""}`, "ph-file-arrow-down");
    } catch (e) {
      console.error("Import failed:", e);
      modal.confirm({ title: `${label} import failed`, message: String(e), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    } finally { setBusy(null); }
  };

  const onImportObsidian = async () => {
    if (!workspaceId) return;
    const dir = await open({ directory: true, multiple: false, title: "Select Obsidian vault folder" });
    if (!dir || Array.isArray(dir)) return;
    setBusy("import");
    try {
      const res = await importObsidianVault(workspaceId, dir);
      await refresh();
      toast(`Imported ${res.imported} note(s) · ${res.links_created} wikilinks · ${res.attachments} attachments${res.skipped ? ` · ${res.skipped} skipped` : ""}`, "ph-brain");
    } catch (e) {
      console.error("Obsidian import failed:", e);
      modal.confirm({ title: "Obsidian import failed", message: String(e), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    } finally { setBusy(null); }
  };

  const onExportArchive = async () => {
    const dest = await save({ title: "Export workspace", defaultPath: "workspace.loom", filters: [{ name: "Loom Workspace", extensions: ["loom"] }] });
    if (!dest) return;
    setBusy("archive");
    try {
      const count = await exportWorkspaceArchive(dest);
      toast(`Workspace exported · ${count} files packaged`, "ph-package");
    } catch (e) {
      console.error("Export archive failed:", e);
      modal.confirm({ title: "Export failed", message: String(e), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    } finally { setBusy(null); }
  };

  const onRestoreArchive = async () => {
    const src = await open({ multiple: false, title: "Restore workspace", filters: [{ name: "Loom Workspace", extensions: ["loom"] }] });
    if (!src || Array.isArray(src)) return;
    const ok = await modal.confirm({
      title: "Restore workspace?",
      message: "This replaces your current workspace (notes, files, settings, themes) with the archive's contents. Your current database is backed up to loom.db.pre-restore. The restore is applied when you next restart Loom.",
      icon: "ph-package", danger: true, confirmLabel: "Stage restore",
    });
    if (!ok) return;
    setBusy("archive");
    try {
      await importWorkspaceArchive(src);
      modal.confirm({ title: "Restore staged", message: "Quit and reopen Loom to complete the restore.", icon: "ph-check-circle", confirmLabel: "OK" });
    } catch (e) {
      console.error("Restore archive failed:", e);
      modal.confirm({ title: "Restore failed", message: String(e), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    } finally { setBusy(null); }
  };

  const onApplyTemplate = async (tplId: string) => {
    if (!workspaceId) return;
    const tpl = WORKSPACE_TEMPLATES.find((t) => t.id === tplId);
    if (!tpl) return;
    const ok = await modal.confirm({ title: `Apply “${tpl.name}” template`, message: `Add ${tpl.notes.length} starter notes to this workspace?`, icon: tpl.icon, confirmLabel: "Add notes" });
    if (!ok) return;
    setBusy("template");
    try {
      const n = await applyWorkspaceTemplate(workspaceId, tpl);
      await refresh();
      toast(`Added ${n} notes from ${tpl.name}`, tpl.icon);
    } catch (e) {
      console.error("Template apply failed:", e);
      modal.confirm({ title: "Template failed", message: String(e), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    } finally { setBusy(null); }
  };

  const chooseStartup = (id: string) => {
    setStartup(id);
    setStartupView(id);
    toast("Startup view saved", "ph-rocket-launch");
  };

  const onReset = async () => {
    const ok = await modal.confirm({
      title: "Reset dashboard", message: "Reset the dashboard layout to default? This cannot be undone.",
      icon: "ph-arrow-counter-clockwise", danger: true, confirmLabel: "Reset layout",
    });
    if (!ok) return;
    if (!workspaceId) return;
    await saveDashboard(defaultDashboardLayout(workspaceId));
    toast("Dashboard layout reset", "ph-arrow-counter-clockwise");
  };

  const onClearAppData = async () => {
    const ok = await modal.confirm({
      title: "Clear App Data",
      message: "Permanently delete all user-generated runtime data (Notes, widgets, local state)? This will reset the app to a fresh state and CANNOT be undone.",
      icon: "ph-trash",
      danger: true,
      confirmLabel: "Delete All Data",
    });
    if (!ok) return;
    
    setBusy("clearing");
    try {
      // Step 0: Freeze all frontend systems before making ANY backend calls
      mutationEngine.freeze();

      // Step 1-7: The backend wipe (includes backend system freeze)
      await clearAllUserData();

      // Clear all transient caches
      window.localStorage.clear();
      window.sessionStorage.clear();

      // Reboot. Unfreeze happens after rehydration in ItemStore.
      window.location.reload();
    } catch (e) {
      console.error("Clear app data failed:", e);
      toast("Failed to clear app data", "ph-warning");
      mutationEngine.unfreeze(); // Safe recovery
      setBusy(null);
    }
  };

  const onExport = async () => {
    setBusy("export");
    try {
      const path = await exportData();
      if (path) toast("Data exported", "ph-download-simple");
      // null = user cancelled the dialog → no toast, no fake success
    } catch (e) {
      console.error("Export failed:", e);
      toast("Export failed", "ph-warning");
    } finally {
      setBusy(null);
    }
  };

  const onBackup = async () => {
    setBusy("backup");
    try {
      const path = await backupDatabase();
      if (path) toast("Backup created", "ph-database");
    } catch (e) {
      console.error("Backup failed:", e);
      toast("Backup failed", "ph-warning");
    } finally {
      setBusy(null);
    }
  };

  const onRestore = async () => {
    const ok = await modal.confirm({
      title: "Restore from export",
      message: "Merge a LOOM export (.json) into this workspace? Existing items with matching IDs are overwritten.",
      icon: "ph-upload-simple", confirmLabel: "Choose file",
    });
    if (!ok) return;
    setBusy("restore");
    try {
      const summary = await importData();
      if (summary) {
        await refresh();
        toast(summary, "ph-upload-simple");
      }
      // null = user cancelled the dialog → no toast, no fake success
    } catch (e) {
      console.error("Restore failed:", e);
      modal.confirm({ title: "Restore failed", message: String(e), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--accent)" } as any}>
      <div className="page-head">
        <div className="ph-meta">
          <div className="page-kicker" style={{ "--mod": "var(--accent)" } as any}><I n="ph-gear-six" w="fill" /> Settings</div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Every control here performs a real, persisted action.</p>
        </div>
      </div>

      {/* Appearance */}
      <Section icon="ph-palette" title="Appearance" sub="Theme and accent apply immediately and persist across restarts.">
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={themePref === t.id}
              className={cx("theme-card", themePref === t.id && "on")}
              onClick={() => { setTheme(t.id); toast(`Theme: ${t.label}`, t.icon); }}
            >
              <span className="theme-swatch" style={{ background: t.swatch.bg }} aria-hidden>
                <I n={t.icon} style={{ color: t.swatch.fg }} />
              </span>
              <span className="theme-meta">
                <span className="theme-name">{t.label}</span>
                <span className="theme-desc">{t.desc}</span>
              </span>
              {themePref === t.id && <I n="ph-check-circle" w="fill" style={{ color: "var(--accent-text)" }} />}
            </button>
          ))}
          <button
            role="radio"
            aria-checked={themePref === "system"}
            className={cx("theme-card", themePref === "system" && "on")}
            onClick={() => { setTheme("system"); toast("Theme: System", "ph-desktop"); }}
          >
            <span className="theme-swatch theme-swatch-split" aria-hidden>
              <I n="ph-desktop" />
            </span>
            <span className="theme-meta">
              <span className="theme-name">System</span>
              <span className="theme-desc">Follows the OS scheme</span>
            </span>
            {themePref === "system" && <I n="ph-check-circle" w="fill" style={{ color: "var(--accent-text)" }} />}
          </button>
        </div>

        <div className="divider"></div>

        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Accent color</div>
            <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Tints buttons, highlights, and focus rings in every theme.</div>
          </div>
          <div className="accent-row" role="radiogroup" aria-label="Accent color">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                role="radio"
                aria-checked={accent === a.id}
                aria-label={a.label}
                title={a.label}
                className={cx("accent-dot", accent === a.id && "on")}
                style={{ "--swatch": a.preview } as any}
                onClick={() => { setAccent(a.id); toast(`Accent: ${a.label}`, "ph-palette"); }}
              >
                {accent === a.id && <I n="ph-check" w="bold" />}
              </button>
            ))}
            {/* Enhancement 42: Infinite Accent Colors */}
            <input type="color" title="Custom Hex Color" className="accent-dot" style={{ width: 28, height: 28, padding: 0, border: 'none', cursor: 'pointer', borderRadius: '50%' }} onChange={(e) => { setAccent("custom"); document.documentElement.style.setProperty('--accent', e.target.value); }} />
          </div>
        </div>

        {/* Enhancements 43, 44, 45, 41: Customization & Typography */}
        <div className="divider"></div>
        <div className="col gap12">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Typography</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Choose the primary font for the interface.</div>
            </div>
            <select className="rx-select" value={font} style={{ padding: "4px 8px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", color: "var(--text)" }} onChange={(e) => chooseFont(e.target.value)}>
              {FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Density Mode</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Adjust spacing to comfortable, compact, or dense.</div>
            </div>
            <select className="rx-select" value={density} style={{ padding: "4px 8px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", color: "var(--text)" }} onChange={(e) => chooseDensity(e.target.value as any)}>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
              <option value="dense">Dense</option>
            </select>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Dynamic Ambient Backgrounds</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Slow-moving mesh gradients on the app background.</div>
            </div>
            <Switch.Root className="rx-switch" checked={ambient} onCheckedChange={toggleAmbient} aria-label="Ambient background">
              <Switch.Thumb className="rx-switch-thumb" />
            </Switch.Root>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Acrylic Mode</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Frosted glass surfaces on cards, navigation, popovers, modals, and menus.</div>
            </div>
            <Switch.Root className="rx-switch" checked={acrylic} onCheckedChange={toggleAcrylic} aria-label="Acrylic mode">
              <Switch.Thumb className="rx-switch-thumb" />
            </Switch.Root>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Navigation Layout</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Switch between sidebar and top pill navigation. Routes and permissions are identical.</div>
            </div>
            <div className="seg" role="group" aria-label="Navigation style">
              <button
                id="nav-style-sidebar-btn"
                className={cx(navStyle === "sidebar" && "on")}
                onClick={() => chooseNavStyle("sidebar")}
                aria-pressed={navStyle === "sidebar"}
              >
                <I n="ph-sidebar-simple" /> Sidebar
              </button>
              <button
                id="nav-style-top-pill-btn"
                className={cx(navStyle === "top-pill" && "on")}
                onClick={() => chooseNavStyle("top-pill")}
                aria-pressed={navStyle === "top-pill"}
              >
                <I n="ph-dots-three-outline" /> Top Pill
              </button>
            </div>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Custom Theme</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Design tokens for color, typography, shape, and effects — live preview, no restart. Save, export, and import multiple themes.</div>
            </div>
            <Button iconLeft="ph-paint-brush-broad" onClick={() => setThemeStudio(true)}>Open Theme Studio</Button>
          </div>
          <div className="divider"></div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Custom CSS</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Drop .css files in the Custom CSS folder. They reload automatically when Loom regains focus, or reload now.</div>
            </div>
            <div className="row gap6">
              <Button iconLeft="ph-folder-open" onClick={() => revealCustomCssFolder().catch(console.error)}>Open folder</Button>
              <Button iconLeft="ph-arrows-clockwise" onClick={async () => { await reloadCustomCss(); toast("Custom CSS reloaded", "ph-arrows-clockwise"); }}>Reload CSS</Button>
            </div>
          </div>
        </div>
      </Section>

      {/* Startup */}
      <Section icon="ph-rocket-launch" title="Startup view" sub="The module LOOM opens into when launched.">
        <div className="row wrap gap8">
          {STARTUP_VIEWS.map((v) => (
            <button key={v.id} className={cx("btn", startup === v.id && "primary")} onClick={() => chooseStartup(v.id)}>
              <I n={v.icon} {...(startup === v.id ? { w: "fill" as const } : {})} /> {v.label}
            </button>
          ))}
        </div>
      </Section>

      {/* Recovery */}
      <Section icon="ph-clock-counter-clockwise" title="Recovery" sub="Undo at workspace scale — restore deleted items or roll the whole workspace back to a snapshot.">
        <RecoveryPanel />
      </Section>

      {/* Data */}
      <Section icon="ph-database" title="Data" sub="Export your content or back up the database to a file you choose.">
        <div className="col gap12">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Export data (JSON)</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>All tasks, notes, library, calendar, bookmarks, projects, habits, files & links.</div>
            </div>
            <Button iconLeft="ph-download-simple" loading={busy === "export"} onClick={onExport}>
              Export
            </Button>
          </div>
          <div className="divider"></div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Backup database (.db)</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>A consistent standalone copy of the live SQLite database — restorable.</div>
            </div>
            <Button iconLeft="ph-database" loading={busy === "backup"} onClick={onBackup}>
              Backup
            </Button>
          </div>
          <div className="divider"></div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Restore from export (JSON)</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Rehydrate items, links, metadata, vault values, settings & dashboard from a LOOM export.</div>
            </div>
            <Button iconLeft="ph-upload-simple" loading={busy === "restore"} onClick={onRestore}>
              Restore
            </Button>
          </div>
          <div className="divider"></div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Universal Import</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Robust migration tools to pull data from external tools.</div>
            </div>
            <div className="row gap6">
               <Button iconLeft="ph-brain" loading={busy === "import"} onClick={onImportObsidian}>Obsidian Vault</Button>
               <Button iconLeft="ph-file-arrow-down" loading={busy === "import"} onClick={() => onImportFolder("Notion")}>Notion</Button>
            </div>
          </div>
          <div className="divider"></div>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Workspace Templates</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Seed this workspace with a ready-made set of starter notes.</div>
            </div>
            <div className="row gap6" style={{ flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 360 }}>
              {WORKSPACE_TEMPLATES.map((t) => (
                <Button key={t.id} iconLeft={t.icon} loading={busy === "template"} onClick={() => onApplyTemplate(t.id)}>{t.name}</Button>
              ))}
            </div>
          </div>
          <div className="divider"></div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Workspace Portability (.loom)</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Package your entire workspace — database, settings, themes, notes & attachments — into one portable archive, or restore from one.</div>
            </div>
            <div className="row gap6">
               <Button iconLeft="ph-package" loading={busy === "archive"} onClick={onExportArchive}>Export .loom</Button>
               <Button iconLeft="ph-arrow-counter-clockwise" loading={busy === "archive"} onClick={onRestoreArchive}>Restore</Button>
            </div>
          </div>
          <div className="divider"></div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Database Optimization</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Run SQLite VACUUM to compact and defragment the database file.</div>
            </div>
            <Button iconLeft="ph-broom" loading={busy === "optimize"} onClick={onOptimizeDb}>Optimize DB</Button>
          </div>
        </div>
      </Section>

      {/* Advanced & Sync — none of these have a backend yet. Shown disabled and clearly
          labelled experimental so the UI never claims work it didn't do. */}
      <Section icon="ph-sparkle" title="Advanced & Sync" sub="Planned features. Disabled until their backends ship.">
        <div className="col gap12">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="row gap8"><div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Local-First CRDT Sync</div><span className="chip" style={{ height: 20 }}><I n="ph-flask" /> Experimental</span></div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Conflict-free multi-device sync over P2P. Not yet implemented.</div>
            </div>
            <Button iconLeft="ph-plugs-connected" disabled>Connect Peer</Button>
          </div>
          <div className="divider"></div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="row gap8"><div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Local LLM (Chat with Workspace)</div><span className="chip" style={{ height: 20 }}><I n="ph-flask" /> Experimental</span></div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>RAG over the local database. Not yet implemented.</div>
            </div>
            <Switch.Root className="rx-switch" disabled checked={false} aria-label="Local LLM (unavailable)">
              <Switch.Thumb className="rx-switch-thumb" />
            </Switch.Root>
          </div>
          <div className="divider"></div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="row gap8"><div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Mobile Companion App</div><span className="chip" style={{ height: 20 }}><I n="ph-flask" /> Experimental</span></div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Pair a phone to capture on the go. Not yet implemented.</div>
            </div>
            <Button iconLeft="ph-qr-code" disabled>Generate QR</Button>
          </div>
        </div>
      </Section>

      {/* Shortcuts */}
      <Section icon="ph-keyboard" title="Keyboard shortcuts" sub="The actual bindings active in the application.">
        <div className="col gap8">
          {SHORTCUTS.map((sc) => (
            <div key={sc.id} className="row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: "var(--fs-md)" }}>{sc.label}</span>
              <span className="row gap6">
                {sc.keys.map((k, i) => <span key={i} className="kbd">{k}</span>)}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Danger zone */}
      <Section danger icon="ph-warning-octagon" title="Danger zone" sub="Destructive actions. Each one asks for confirmation first.">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Reset dashboard layout</div>
            <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Reverts reorder, resize, and hidden widgets to the default arrangement. Cannot be undone.</div>
          </div>
          <Button variant="destructive" iconLeft="ph-arrow-counter-clockwise" onClick={onReset}>
            Reset layout
          </Button>
        </div>
        <div className="divider" style={{ margin: "16px 0", background: "var(--border)" }}></div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Clear App Data (Dev Cleanup)</div>
            <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Permanently delete all user-generated runtime data (Notes, widgets, local state). Does not affect codebase.</div>
          </div>
          <Button variant="destructive" iconLeft="ph-trash" loading={busy === "clearing"} onClick={onClearAppData}>
            Clear Data
          </Button>
        </div>
      </Section>

      <AnimatePresence>
        {themeStudio && <ThemeStudio onClose={() => setThemeStudio(false)} />}
      </AnimatePresence>
    </div>
  );
}
