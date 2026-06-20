import { useState } from "react";
import { Editor } from "@tiptap/react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { I } from "../lib/context";
import { MediaKind, toEmbedUrl } from "./MediaEmbed";

interface MediaToolsProps {
  editor: Editor;
  importFile: (path: string, strategy: "copy" | "reference") => Promise<{ path: string; filename: string }>;
  toast: (msg: string, icon?: string) => void;
  confirmCopy: (filename: string) => Promise<boolean>;
}

const PICKERS: { kind: MediaKind; label: string; icon: string; ext: string[] }[] = [
  { kind: "pdf", label: "PDF", icon: "ph-file-pdf", ext: ["pdf"] },
  { kind: "video", label: "Video", icon: "ph-video", ext: ["mp4", "webm", "mov", "mkv", "avi"] },
  { kind: "audio", label: "Audio", icon: "ph-music-notes", ext: ["mp3", "wav", "ogg", "flac", "m4a"] },
];

export function MediaTools({ editor, importFile, toast, confirmCopy }: MediaToolsProps) {
  const [open_, setOpen] = useState(false);

  const insertLocal = async (kind: MediaKind, ext: string[]) => {
    setOpen(false);
    const selected = await open({ multiple: false, title: `Embed ${kind}`, filters: [{ name: kind, extensions: ext }] });
    if (!selected) return;
    const filePath = Array.isArray(selected) ? selected[0] : selected;
    const filename = filePath.split(/[\/\\]/).pop() || "file";
    const copy = await confirmCopy(filename);
    try {
      const imported = await importFile(filePath, copy ? "copy" : "reference" as "copy" | "reference");
      editor.chain().focus().setMediaEmbed({ kind, src: convertFileSrc(imported.path), title: imported.filename }).run();
      toast(`${kind} embedded`, "ph-monitor-play");
    } catch (err: any) {
      toast(String(err), "ph-warning");
    }
  };

  const insertWeb = () => {
    setOpen(false);
    const url = window.prompt("Embed a web page or video (URL):", "https://");
    if (!url || url === "https://") return;
    editor.chain().focus().setMediaEmbed({ kind: "web", src: toEmbedUrl(url), title: url }).run();
    toast("Web embed inserted", "ph-globe");
  };

  return (
    <span style={{ position: "relative" }}>
      <button onMouseDown={(e) => { e.preventDefault(); setOpen((v) => !v); }} title="Embed media">
        <I n="ph-monitor-play" w="bold" /> Media
      </button>
      {open_ && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 1000, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", boxShadow: "var(--shadow-md)", padding: 4, minWidth: 170 }}>
          {PICKERS.map((p) => (
            <button key={p.kind} onMouseDown={(e) => { e.preventDefault(); insertLocal(p.kind, p.ext); }} className="media-menu-item">
              <I n={p.icon} /> {p.label}
            </button>
          ))}
          <button onMouseDown={(e) => { e.preventDefault(); insertWeb(); }} className="media-menu-item">
            <I n="ph-globe" /> Web embed
          </button>
        </div>
      )}
    </span>
  );
}
