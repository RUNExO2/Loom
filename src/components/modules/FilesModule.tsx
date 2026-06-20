import React, { useState, useEffect, useMemo } from "react";
import { I, useLoom, clickable } from "../../lib/context";
import { Item } from "../../ipc/items";
import { useFiles, useItemStore } from "../../lib/itemStore";
import { getFileMeta } from "../../lib/meta";
import { createFilesViewModel } from "../../lib/viewmodels";
import { useModal } from "../Modal";
import { EmptyState } from "../shared";
import { AsyncButton } from "../ui/AsyncButton";
import { fsReadNoteContent } from "../../ipc/fs";
import { encryptFile, decryptFile, indexTextFiles } from "../../ipc/content";
import { convertFileSrc } from "@tauri-apps/api/core";
import { PageHead } from "./shared";

const EXT_ICON: Record<string, string> = {
  PDF: "ph-file-pdf", DOC: "ph-file-doc", DOCX: "ph-file-doc", TEX: "ph-file-doc", MD: "ph-file-text",
  CSV: "ph-table", PARQ: "ph-table", XLSX: "ph-table", SH: "ph-terminal-window",
  PNG: "ph-image", JPG: "ph-image", ASE: "ph-image", ZIP: "ph-file-zip",
};
const iconForExt = (ext: string) => EXT_ICON[(ext || "").toUpperCase()] || "ph-file";

const PREVIEW_IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];
const PREVIEW_VIDEO = ["mp4", "webm", "ogg", "mov", "mkv"];
const PREVIEW_AUDIO = ["mp3", "wav", "flac", "m4a", "aac"];
const PREVIEW_TEXT = ["md", "markdown", "txt", "csv", "log", "json", "xml", "yml", "yaml"];
export const PREVIEWABLE_EXTS = [...PREVIEW_IMAGE, ...PREVIEW_VIDEO, ...PREVIEW_AUDIO, ...PREVIEW_TEXT];

function FilePreview({ media, onClose, onOpenExternal }: {
  media: { path: string; ext: string };
  onClose: () => void;
  onOpenExternal: () => void;
}) {
  const { path, ext } = media;
  const src = convertFileSrc(path);
  const isImage = PREVIEW_IMAGE.includes(ext);
  const isVideo = PREVIEW_VIDEO.includes(ext);
  const isAudio = PREVIEW_AUDIO.includes(ext);
  const isText = PREVIEW_TEXT.includes(ext);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isText) return;
    let alive = true;
    fsReadNoteContent(path).then((c) => alive && setText(c)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [path, isText]);

  const name = path.split(/[\/\\]/).pop() || path;
  const Fallback = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "50px 60px", textAlign: "center" }}>
      <I n="ph-file-dashed" style={{ fontSize: 48, color: "var(--text-faint)" }} />
      <div className="muted">No in-app preview for <strong>{name}</strong>.</div>
      <button className="btn primary sm" onClick={onOpenExternal}><I n="ph-arrow-square-out" w="bold" /> Open externally</button>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }} onClick={onClose}>
      <button className="btn icon" style={{ position: "absolute", top: 20, right: 20, background: "rgba(255,255,255,0.1)", color: "#fff" }} onClick={onClose}><I n="ph-x" /></button>
      <div style={{ maxWidth: "90vw", maxHeight: "90vh", overflow: "auto", background: "var(--surface-1)", borderRadius: "var(--r-lg)", padding: 20, boxShadow: "0 10px 40px rgba(0,0,0,0.5)" }} onClick={(e) => e.stopPropagation()}>
        {isImage && (failed
          ? Fallback
          : <img src={src} onError={() => setFailed(true)} style={{ maxWidth: "82vw", maxHeight: "80vh", objectFit: "contain", display: "block" }} alt={name} />)}
        {isVideo && <video src={src} controls autoPlay onError={() => setFailed(true)} style={{ maxWidth: "82vw", maxHeight: "80vh", display: "block" }} />}
        {isAudio && <audio src={src} controls autoPlay onError={() => setFailed(true)} />}
        {isText && (failed
          ? Fallback
          : text === null
            ? <div className="muted" style={{ padding: 40 }}>Loading preview…</div>
            : <pre style={{ maxWidth: "82vw", maxHeight: "80vh", overflow: "auto", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)", lineHeight: 1.6 }}>{text}</pre>)}
        {!isImage && !isVideo && !isAudio && !isText && Fallback}
      </div>
    </div>
  );
}

export function FilesModule() {
  const { inspect, toast } = useLoom();
  const modal = useModal();
  const { items, create, updateFields, remove, ready, importFile, openFile, revealInExplorer, workspaceId } = useFiles();
  const { refresh } = useItemStore();
  const [sort, setSort] = useState<{ key: "name" | "type" | "size" | "modified"; dir: 1 | -1 }>({ key: "modified", dir: -1 });
  const { rows: list, folders } = useMemo(
    () => createFilesViewModel({ files: items }, { sortKey: sort.key, sortDir: sort.dir }),
    [items, sort],
  );
  const toggleSort = (key: "name" | "type" | "size" | "modified") => setSort((s) => s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 });
  const sortArrow = (key: string) => sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : "";

  useEffect(() => {
    const handleGlobalDrop = async (e: Event) => {
      const customEvent = e as CustomEvent;
      const paths = customEvent.detail?.paths;
      if (!paths || paths.length === 0) return;

      for (const p of paths) {
        const filename = p.split(/[\/\\]/).pop() || "file";
        const isCopy = await modal.confirm({
          title: "Import Strategy",
          message: `File: ${filename}\n\nCopy file into Loom or keep it where it is?`,
          icon: "ph-copy",
          confirmLabel: "Copy to Loom",
          cancelLabel: "Keep Reference"
        });
        const strat = isCopy ? "copy" : "reference";
        try {
          await importFile(p, strat);
          toast("File imported", "ph-check");
        } catch (err: any) {
          modal.confirm({ title: "Import Error", message: String(err), icon: "ph-warning", danger: true });
        }
      }
    };

    window.addEventListener("loom-file-drop", handleGlobalDrop);
    return () => {
      window.removeEventListener("loom-file-drop", handleGlobalDrop);
    };
  }, [importFile, modal, toast]);

  const handleNew = async () => {
    const r = await modal.form({ panel: true,
      title: "New file entry", icon: "ph-file-plus", accent: "var(--h-files)", submitLabel: "Create file",
      fields: [
        { name: "title", label: "File name", placeholder: "e.g. notes.txt", required: true },
        { name: "ext", label: "Type / extension", placeholder: "txt, md…" },
        { name: "folder", label: "Folder", defaultValue: "Unfiled" },
      ],
    });
    if (!r) return;
    const ext = (r.ext || (r.title.includes(".") ? r.title.split(".").pop()! : "txt")).toLowerCase();
    const folder = r.folder || "Unfiled";
    try {
      await create(r.title, { folder, ext });
      toast("File created on disk", "ph-file-plus");
    } catch (err: any) {
      console.error("Failed to create file:", err);
      modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleRename = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const r = await modal.form({ panel: true,
      title: "Rename file", icon: "ph-pencil", accent: "var(--h-files)", submitLabel: "Rename",
      fields: [{ name: "title", label: "New Name (without extension)", defaultValue: item.title, required: true }],
    });
    if (!r) return;
    try { await updateFields(item.id, r.title); toast("File renamed", "ph-pencil"); }
    catch (err: any) {
      console.error("Failed to rename file:", err);
      modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation();
    const ok = await modal.confirm({ title: "Delete file", message: `Delete "${title}"? This will remove the file from the filesystem if it was copied to Loom.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try { await remove(id); toast("File deleted", "ph-trash"); }
    catch (err: any) {
      console.error("Failed to delete file:", err);
      modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleReveal = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    try { await revealInExplorer(path); }
    catch (err: any) { console.error("Failed to reveal:", err); }
  };

  const [previewMedia, setPreviewMedia] = useState<{ path: string; ext: string } | null>(null);

  const handleOpen = async (e: React.MouseEvent | null, path: string, ext: string) => {
    e?.stopPropagation();
    const lowerExt = ext.toLowerCase();
    if (PREVIEWABLE_EXTS.includes(lowerExt)) {
      setPreviewMedia({ path, ext: lowerExt });
    } else {
      try { await openFile(path); }
      catch (err: any) {
        console.error("Failed to open:", err);
        modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
      }
    }
  };

  const handleEncrypt = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getFileMeta(item);
    const isEnc = meta.path.toLowerCase().endsWith(".enc");

    if (isEnc) {
      const r = await modal.form({ panel: true,
        title: "Decrypt file", icon: "ph-lock-open", accent: "var(--h-files)", submitLabel: "Decrypt",
        fields: [{ name: "password", label: "Password", type: "password", required: true }],
      });
      if (!r) return;
      try {
        await decryptFile(item.id, r.password);
        await refresh();
        toast("File decrypted", "ph-lock-open");
      } catch (err: any) {
        modal.confirm({ title: "Decryption failed", message: String(err), icon: "ph-warning", danger: true, confirmLabel: "OK" });
      }
      return;
    }

    const r = await modal.form({ panel: true,
      title: "Encrypt file", icon: "ph-lock", accent: "var(--h-files)", submitLabel: "Encrypt",
      fields: [
        { name: "password", label: "Password", type: "password", required: true, placeholder: "Choose a strong password" },
        { name: "confirm", label: "Confirm password", type: "password", required: true },
      ],
    });
    if (!r) return;
    if (r.password !== r.confirm) {
      modal.confirm({ title: "Passwords don't match", message: "The two passwords are different. Nothing was changed.", icon: "ph-warning", danger: true, confirmLabel: "OK" });
      return;
    }
    try {
      await encryptFile(item.id, r.password);
      await refresh();
      toast("File encrypted (AES-256-GCM)", "ph-lock-key");
    } catch (err: any) {
      modal.confirm({ title: "Encryption failed", message: String(err), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    }
  };

  const handleIndexText = async () => {
    if (!workspaceId) return;
    try {
      const res = await indexTextFiles(workspaceId);
      await refresh();
      toast(`Indexed ${res.indexed} of ${res.total} files (${res.skipped} skipped)`, "ph-text-aa");
    } catch (err: any) {
      modal.confirm({ title: "Indexing failed", message: String(err), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    }
  };

  const COLS = "1fr 90px 80px 110px 184px";
  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-files)" } as any}>
      <PageHead mod="var(--h-files)" icon="ph-folder" kicker="Files" title="Everything you've attached"
        sub={`${list.length} files · ${folders.length} folders`}>
        <AsyncButton className="btn outline" onClick={handleIndexText} icon="ph-text-aa" loadingLabel="Indexing…" title="Index text-based files so search can match their contents">Index Text</AsyncButton>
        <button className="btn primary" onClick={handleNew}><I n="ph-file-plus" w="bold" /> New file</button>
      </PageHead>
      <div className="row wrap gap12" style={{ marginBottom: 22 }}>
        {folders.map((f) => (
          <div key={f} className="chip" style={{ "--mod": "var(--h-files)", height: 40, padding: "0 16px", borderRadius: "var(--r-md)" } as any}>
            <I n="ph-folder" w="fill" style={{ color: "var(--h-files)", fontSize: "var(--fs-2xl)" }} /> <span style={{ fontWeight: 550 }}>{f}</span>
            <span className="mono-sm ghost">{list.filter(({ meta }) => meta.folder.startsWith(f)).length}</span>
          </div>
        ))}
      </div>
      {!ready ? (
        <div className="muted" style={{ padding: "20px 0" }}>Loading files...</div>
      ) : list.length === 0 ? (
        <EmptyState icon="ph-folder" mod="var(--h-files)" title="No files yet" sub="Drag and drop files here, or create a new one.">
          <button className="btn primary sm" style={{ marginTop: 12 }} onClick={handleNew}><I n="ph-file-plus" w="bold" /> New file</button>
        </EmptyState>
      ) : (
      <div style={{ background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: COLS, padding: "10px 16px", borderBottom: "1px solid var(--border)" }} className="mono-sm ghost">
          <button className="file-sort" onClick={() => toggleSort("name")}>NAME{sortArrow("name")}</button>
          <button className="file-sort" onClick={() => toggleSort("type")}>TYPE{sortArrow("type")}</button>
          <button className="file-sort" onClick={() => toggleSort("size")}>SIZE{sortArrow("size")}</button>
          <button className="file-sort" onClick={() => toggleSort("modified")}>MODIFIED{sortArrow("modified")}</button>
          <span style={{ textAlign: "right" }}></span>
        </div>
        {list.map(({ item, meta }) => (
          <div key={item.id} className="wrow" style={{ "--mod": meta.color, display: "grid", gridTemplateColumns: COLS, margin: 0, padding: "11px 16px", borderRadius: 0, borderTop: "1px solid var(--border-faint)", alignItems: "center" } as any}>
            <div className="row gap12" style={{ minWidth: 0, cursor: "pointer" }}
                 title={`Open ${item.title}`}
                 onClick={() => handleOpen(null, meta.path, meta.ext)}
                 {...clickable(() => handleOpen(null, meta.path, meta.ext))}>
              <div className="wrow-ico" style={{ width: 28, height: 28, flex: "0 0 28px", fontSize: "var(--fs-base)" }}><I n={iconForExt(meta.ext)} /></div>
              <div style={{ minWidth: 0 }}>
                <div className="wrow-t">{item.title}</div>
                <div className="wrow-s" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta.path}</div>
              </div>
            </div>
            <span className="mono-sm muted">{meta.ext}</span>
            <span className="mono-sm muted">{meta.size}</span>
            <span className="mono-sm ghost">{meta.updated}</span>
            <div className="row gap8" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn icon sm" style={{ padding: 7 }} onClick={(e) => handleEncrypt(e, item)} title={meta.path.toLowerCase().endsWith(".enc") ? "Decrypt" : "Encrypt"}>
                <I n={meta.path.toLowerCase().endsWith(".enc") ? "ph-lock-key" : "ph-lock"} style={{ color: meta.path.toLowerCase().endsWith(".enc") ? "var(--h-vault)" : "var(--text-faint)" }} />
              </button>
              <button type="button" className="btn icon sm" style={{ padding: 7 }} onClick={(e) => { e.stopPropagation(); inspect(item.id); }} title="Details">
                <I n="ph-magnifying-glass" style={{ color: "var(--text-faint)" }} />
              </button>
              <button type="button" className="btn icon sm" style={{ padding: 7 }} onClick={(e) => handleReveal(e, meta.path)} title="Reveal in Explorer">
                <I n="ph-folder-open" style={{ color: "var(--text-faint)" }} />
              </button>
              <button type="button" className="btn icon sm" style={{ padding: 7 }} onClick={(e) => handleRename(e, item)} title="Rename">
                <I n="ph-pencil" style={{ color: "var(--text-faint)" }} />
              </button>
              <button type="button" className="btn icon sm" style={{ padding: 7 }} onClick={(e) => handleDelete(e, item.id, item.title)} title="Delete">
                <I n="ph-trash" style={{ color: "var(--text-faint)" }} />
              </button>
            </div>
          </div>
        ))}
      </div>
      )}
      {previewMedia && (
        <FilePreview
          media={previewMedia}
          onClose={() => setPreviewMedia(null)}
          onOpenExternal={() => { const p = previewMedia.path; setPreviewMedia(null); openFile(p).catch(() => {}); }}
        />
      )}
    </div>
  );
}
