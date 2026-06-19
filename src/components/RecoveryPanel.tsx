import { useState, useEffect, useCallback } from "react";
import { I } from "../lib/context";
import { useLoom } from "../lib/context";
import { useItemStore } from "../lib/itemStore";
import { useModal } from "./Modal";
import { Button } from "./ui/Button";
import {
  getDeletionHistory, restoreDeletedItem, DeletedItem,
  getWorkspaceSnapshots, createWorkspaceSnapshot, deleteWorkspaceSnapshot,
  restoreWorkspaceSnapshot, SnapshotMeta,
} from "../ipc/recovery";
import { TYPE_ICON, TYPE_COLOR } from "../lib/typeMeta";

// ── Recovery panel ──────────────────────────────────────────────────────────────
// Deletion history (see + restore soft-deleted items) and whole-workspace snapshots
// (capture / roll back / delete). A thin client over the recovery IPC; every
// destructive action is gated behind a confirm and reconciles the item store after.
function fmtWhen(s: string | null): string {
  if (!s) return "unknown time";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function RecoveryPanel() {
  const { toast } = useLoom();
  const { workspaceId, refresh } = useItemStore();
  const modal = useModal();
  const [deleted, setDeleted] = useState<DeletedItem[]>([]);
  const [snaps, setSnaps] = useState<SnapshotMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!workspaceId) return;
    getDeletionHistory(workspaceId).then(setDeleted).catch(() => {});
    getWorkspaceSnapshots(workspaceId).then(setSnaps).catch(() => {});
  }, [workspaceId]);
  useEffect(() => { load(); }, [load]);

  const onRestore = async (it: DeletedItem) => {
    setBusy(it.id);
    try {
      await restoreDeletedItem(it.id);
      await refresh();
      load();
      toast(`“${it.title}” restored`, "ph-arrow-counter-clockwise");
    } catch {
      toast("Restore failed", "ph-warning");
    } finally { setBusy(null); }
  };

  const onSnapshot = async () => {
    if (!workspaceId) return;
    const r = await modal.form({
      title: "Take snapshot", icon: "ph-camera", accent: "var(--accent)", submitLabel: "Capture",
      fields: [{ name: "label", label: "Label", placeholder: "e.g. before big cleanup", defaultValue: "Manual snapshot" }],
    });
    if (!r) return;
    setBusy("snap");
    try {
      await createWorkspaceSnapshot(workspaceId, r.label);
      load();
      toast("Snapshot captured", "ph-camera");
    } catch {
      toast("Snapshot failed", "ph-warning");
    } finally { setBusy(null); }
  };

  const onRollback = async (s: SnapshotMeta) => {
    const ok = await modal.confirm({
      title: "Roll back workspace", danger: true, icon: "ph-clock-counter-clockwise", confirmLabel: "Roll back",
      message: `Restore this workspace to “${s.label}” (${fmtWhen(s.created_at)})? Items created since the snapshot are removed and edits revert. A safety snapshot of the current state is saved first, so this is undoable.`,
    });
    if (!ok) return;
    setBusy(s.id);
    try {
      await restoreWorkspaceSnapshot(s.id);
      await refresh();
      load();
      toast("Workspace rolled back", "ph-clock-counter-clockwise");
    } catch {
      toast("Rollback failed", "ph-warning");
    } finally { setBusy(null); }
  };

  const onDeleteSnap = async (s: SnapshotMeta) => {
    const ok = await modal.confirm({ title: "Delete snapshot", danger: true, icon: "ph-trash", confirmLabel: "Delete", message: `Delete the snapshot “${s.label}”? The workspace data itself is untouched.` });
    if (!ok) return;
    try { await deleteWorkspaceSnapshot(s.id); load(); toast("Snapshot deleted", "ph-trash"); } catch { toast("Delete failed", "ph-warning"); }
  };

  return (
    <div className="col gap20">
      {/* Snapshots */}
      <div>
        <div className="row gap12" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 550, fontSize: "var(--fs-md)" }}>Workspace snapshots</div>
            <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Capture the whole workspace, then roll back to it later. Rollback is itself undoable.</div>
          </div>
          <Button iconLeft="ph-camera" loading={busy === "snap"} onClick={onSnapshot}>Take snapshot</Button>
        </div>
        {snaps.length === 0 ? (
          <div className="ghost mono-sm" style={{ padding: "6px 0" }}>No snapshots yet.</div>
        ) : (
          <div className="col gap6">
            {snaps.map((s) => (
              <div key={s.id} className="row gap12" style={{ justifyContent: "space-between", padding: "8px 10px", background: "var(--surface-2)", borderRadius: "var(--r-md)" }}>
                <div className="row gap8" style={{ minWidth: 0 }}>
                  <I n="ph-camera" style={{ color: "var(--accent)" }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.label}</div>
                    <div className="ghost mono-sm" style={{ fontSize: "var(--fs-2xs)" }}>{fmtWhen(s.created_at)} · {s.item_count} items · {s.link_count} links</div>
                  </div>
                </div>
                <div className="row gap6">
                  <Button size="sm" iconLeft="ph-clock-counter-clockwise" loading={busy === s.id} onClick={() => onRollback(s)}>Roll back</Button>
                  <button className="btn icon sm" onClick={() => onDeleteSnap(s)} title="Delete snapshot"><I n="ph-trash" style={{ color: "var(--text-faint)" }} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Deletion history */}
      <div>
        <div style={{ fontWeight: 550, fontSize: "var(--fs-md)", marginBottom: 4 }}>Deletion history</div>
        <div className="muted" style={{ fontSize: "var(--fs-sm)", marginBottom: 10 }}>Soft-deleted items, newest first. Restore brings the item — and its file, if any — back.</div>
        {deleted.length === 0 ? (
          <div className="ghost mono-sm" style={{ padding: "6px 0" }}>Nothing deleted.</div>
        ) : (
          <div className="col gap6">
            {deleted.map((it) => (
              <div key={it.id} className="row gap12" style={{ justifyContent: "space-between", padding: "8px 10px", background: "var(--surface-2)", borderRadius: "var(--r-md)" }}>
                <div className="row gap8" style={{ minWidth: 0 }}>
                  <I n={TYPE_ICON[it.item_type] || "ph-circle"} w="fill" style={{ color: TYPE_COLOR[it.item_type] || "var(--text-faint)" }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
                    <div className="ghost mono-sm" style={{ fontSize: "var(--fs-2xs)" }}>{it.item_type} · deleted {fmtWhen(it.deleted_at)}</div>
                  </div>
                </div>
                <Button size="sm" iconLeft="ph-arrow-counter-clockwise" loading={busy === it.id} onClick={() => onRestore(it)}>Restore</Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
