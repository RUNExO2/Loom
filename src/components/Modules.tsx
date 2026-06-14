import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import * as Switch from "@radix-ui/react-switch";
import { listStagger, listItem } from "../lib/motionVariants";
import { I, cx, useLoom, clickable } from "../lib/context";
import { EntityChip, EmptyState } from "./shared";
import { Item } from "../ipc/items";
import { useNotes, useLibrary, useVault, useAutomations, useItemStore, useFiles } from "../lib/itemStore";
import { vaultSession } from "../lib/vaultSession";
import { getNoteMeta, getLibraryMeta, getVaultMeta, getAutomationMeta } from "../lib/meta";
import {
  runAutomationNow, getAutomationExecutions, getAutomationStats,
  ExecutionRow, AutomationStats, EVENT_TYPES, ENTITY_TYPES, CMP_OPS, ACTION_TYPES,
} from "../ipc/automation";
import { TIMELINE_KINDS } from "../lib/timeline";
import {
  createTimelineViewModel, createNotesViewModel, createLibraryViewModel,
  createVaultViewModel, createAutomationViewModel, filterExecutions, createGraphViewModel,
} from "../lib/viewmodels";
import { deleteCommand, useCommands } from "../lib/commands";
import { useModal } from "./Modal";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { save, open } from "@tauri-apps/plugin-dialog";
import { fsWriteAnyFile, fsCopyFile, fsOpenFile } from "../ipc/fs";
import { getSetting, setSetting } from "../ipc/items";
import { encryptVaultValue, decryptVaultValue } from "../ipc/content";

function PageHead({ mod, kicker, title, sub, children, icon }: {
  mod: string; kicker: string; title: string; sub?: string; children?: React.ReactNode; icon: string;
}) {
  return (
    <div className="page-head">
      <div className="ph-meta">
        <div className="page-kicker" style={{ "--mod": mod } as any}><I n={icon} w="fill" /> {kicker}</div>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}



function PageHeadCompact({ mod, icon, title, count }: { mod: string; icon: string; title: string; count: number }) {
  return (
    <div>
      <div className="page-kicker" style={{ "--mod": mod, marginBottom: 4 } as any}><I n={icon} w="fill" /> Knowledge</div>
      <div className="row" style={{ gap: 9 }}>
        <h1 className="page-title" style={{ fontSize: "var(--fs-3xl)" }}>{title}</h1>
        <span className="mono-sm ghost">{count}</span>
      </div>
    </div>
  );
}

// ---- FORCE GRAPH CANVAS ----
interface FGNode { id: string; title: string; item_type: string; x: number; y: number; vx: number; vy: number; }
interface FGEdge { source: string; target: string; }
interface GraphPhysics { repulsion: number; attraction: number; gravity: number; }

function ForceGraphCanvas({
  nodes,
  edges,
  physics,
  onNodeClick,
}: {
  nodes: { id: string; title: string; item_type: string }[];
  edges: FGEdge[];
  physics: GraphPhysics;
  onNodeClick: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<FGNode[]>([]);
  const rafRef = useRef<number>(0);
  const tickRef = useRef(0);
  const MAX_TICKS = 500;
  const panRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const dragging = useRef<{ nodeId: string | null; mx: number; my: number; startX: number; startY: number }>({ nodeId: null, mx: 0, my: 0, startX: 0, startY: 0 });
  const panning = useRef<{ active: boolean; sx: number; sy: number; px: number; py: number }>({ active: false, sx: 0, sy: 0, px: 0, py: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.parentElement?.clientWidth || 800;
    const H = canvas.parentElement?.clientHeight || 600;
    canvas.width = W;
    canvas.height = H;
    panRef.current = { x: 0, y: 0 };
    scaleRef.current = 1;
    tickRef.current = 0;

    nodesRef.current = nodes.map((n, i) => {
      const angle = (i / Math.max(nodes.length, 1)) * 2 * Math.PI;
      const r = Math.min(W, H) * 0.35;
      return { ...n, x: W / 2 + r * Math.cos(angle), y: H / 2 + r * Math.sin(angle), vx: 0, vy: 0 };
    });

    const NODE_R = 20;
    const edgeMap = new Map<string, string[]>();
    edges.forEach(e => {
      if (!edgeMap.has(e.source)) edgeMap.set(e.source, []);
      edgeMap.get(e.source)!.push(e.target);
    });

    const physicsStep = () => {
      const nodes = nodesRef.current;
      const rep = physics.repulsion;
      const att = physics.attraction;
      const grav = physics.gravity;
      const cx = W / 2, cy = H / 2;
      const damping = 0.85;
      const dt = 1;

      for (let i = 0; i < nodes.length; i++) {
        let fx = 0, fy = 0;
        fx += (cx - nodes[i].x) * grav;
        fy += (cy - nodes[i].y) * grav;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const d2 = dx * dx + dy * dy + 1;
          const d = Math.sqrt(d2);
          fx += (dx / d) * rep / d2 * 1000;
          fy += (dy / d) * rep / d2 * 1000;
        }
        const neighbors = edgeMap.get(nodes[i].id) || [];
        neighbors.forEach(tid => {
          const t = nodes.find(n => n.id === tid);
          if (!t) return;
          const dx = t.x - nodes[i].x;
          const dy = t.y - nodes[i].y;
          const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
          const rest = 100;
          const stretch = d - rest;
          fx += dx / d * stretch * att * 0.5;
          fy += dy / d * stretch * att * 0.5;
        });
        nodes[i].vx = (nodes[i].vx + fx * dt) * damping;
        nodes[i].vy = (nodes[i].vy + fy * dt) * damping;
        nodes[i].x += nodes[i].vx * dt;
        nodes[i].y += nodes[i].vy * dt;
        nodes[i].x = Math.max(NODE_R, Math.min(W - NODE_R, nodes[i].x));
        nodes[i].y = Math.max(NODE_R, Math.min(H - NODE_R, nodes[i].y));
      }
    };

    let alive = true;
    const loop = () => {
      if (!alive) return;
      if (tickRef.current < MAX_TICKS) {
        physicsStep();
        tickRef.current++;
      }
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };

    const TYPE_COLORS: Record<string, string> = {
      note: "#a78bfa", task: "#f97316", project: "#22c55e", habit: "#ec4899",
      calendar: "#3b82f6", bookmark: "#eab308", library: "#f43f5e", file: "#64748b",
    };

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(panRef.current.x, panRef.current.y);
      ctx.scale(scaleRef.current, scaleRef.current);

      // edges
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      edges.forEach(e => {
        const s = nodesRef.current.find(n => n.id === e.source);
        const t = nodesRef.current.find(n => n.id === e.target);
        if (!s || !t) return;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();
      });

      // nodes
      nodesRef.current.forEach(n => {
        const color = TYPE_COLORS[n.item_type] || "#6b7280";
        ctx.beginPath();
        ctx.arc(n.x, n.y, NODE_R, 0, Math.PI * 2);
        ctx.fillStyle = color + "33";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // label
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        const label = n.title.length > 12 ? n.title.slice(0, 11) + "…" : n.title;
        ctx.fillText(label, n.x, n.y + 3);
      });
      ctx.restore();
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => { alive = false; cancelAnimationFrame(rafRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, edges.length, physics.repulsion, physics.attraction, physics.gravity]);

  const worldPos = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const cx = (clientX - rect.left - panRef.current.x) / scaleRef.current;
    const cy = (clientY - rect.top - panRef.current.y) / scaleRef.current;
    return { x: cx, y: cy };
  }, []);

  const hitTest = useCallback((wx: number, wy: number) => {
    return nodesRef.current.find(n => {
      const dx = n.x - wx, dy = n.y - wy;
      return Math.sqrt(dx * dx + dy * dy) < 22;
    }) ?? null;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || e.altKey) return;
    const { x, y } = worldPos(e.clientX, e.clientY);
    const hit = hitTest(x, y);
    if (hit) {
      dragging.current = { nodeId: hit.id, mx: x - hit.x, my: y - hit.y, startX: e.clientX, startY: e.clientY };
    } else {
      panning.current = { active: true, sx: e.clientX, sy: e.clientY, px: panRef.current.x, py: panRef.current.y };
    }
  }, [worldPos, hitTest]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging.current.nodeId) {
      const { x, y } = worldPos(e.clientX, e.clientY);
      const node = nodesRef.current.find(n => n.id === dragging.current.nodeId);
      if (node) { node.x = x - dragging.current.mx; node.y = y - dragging.current.my; node.vx = 0; node.vy = 0; }
      // Restart sim briefly so neighbors respond
      if (tickRef.current >= MAX_TICKS) {
        tickRef.current = MAX_TICKS - 60;
      }
    } else if (panning.current.active) {
      panRef.current.x = panning.current.px + (e.clientX - panning.current.sx);
      panRef.current.y = panning.current.py + (e.clientY - panning.current.sy);
    }
  }, [worldPos]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (dragging.current.nodeId) {
      const wasDragging = dragging.current.nodeId;
      const movedX = e.clientX - dragging.current.startX;
      const movedY = e.clientY - dragging.current.startY;
      dragging.current = { nodeId: null, mx: 0, my: 0, startX: 0, startY: 0 };
      if (Math.sqrt(movedX * movedX + movedY * movedY) < 5) {
        onNodeClick(wasDragging);
      }
    } else if (panning.current.active) {
      const dx = e.clientX - panning.current.sx, dy = e.clientY - panning.current.sy;
      if (Math.sqrt(dx * dx + dy * dy) < 5) {
        const { x, y } = worldPos(e.clientX, e.clientY);
        const hit = hitTest(x, y);
        if (hit) onNodeClick(hit.id);
      }
      panning.current.active = false;
    }
  }, [worldPos, hitTest, onNodeClick]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scaleRef.current = Math.max(0.2, Math.min(5, scaleRef.current * delta));
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "100%", cursor: "grab", display: "block" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
    />
  );
}

// ---- NOTES ----
function htmlToMarkdown(html: string): string {
  let md = html;
  md = md.replace(/<h1>(.*?)<\/h1>/gim, "# $1\n");
  md = md.replace(/<h2>(.*?)<\/h2>/gim, "## $1\n");
  md = md.replace(/<h3>(.*?)<\/h3>/gim, "### $1\n");
  md = md.replace(/<blockquote>(.*?)<\/blockquote>/gim, "> $1\n");
  md = md.replace(/<b>(.*?)<\/b>/gim, "**$1**");
  md = md.replace(/<strong>(.*?)<\/strong>/gim, "**$1**");
  md = md.replace(/<i>(.*?)<\/i>/gim, "*$1*");
  md = md.replace(/<em>(.*?)<\/em>/gim, "*$1*");
  md = md.replace(/<ul>([\s\S]*?)<\/ul>/gim, (_m, p1) => {
    return p1.replace(/<li>(.*?)<\/li>/gim, "- $1\n");
  });
  md = md.replace(/<ol>([\s\S]*?)<\/ol>/gim, (_m, p1) => {
    let index = 1;
    return p1.replace(/<li>(.*?)<\/li>/gim, (_li: string, text: string) => `${index++}. ${text}\n`);
  });
  md = md.replace(/<p>(.*?)<\/p>/gim, "$1\n\n");
  md = md.replace(/<br\s*\/?>/gim, "\n");
  md = md.replace(/<[^>]+>/g, "");
  return md.trim();
}

export function NotesModule({ focusId }: { focusId?: string | null }) {
  const { inspect, toast } = useLoom();
  const modal = useModal();
  const commands = useCommands();
  const { items: notes, create, updateMeta, updateFields, remove, restore, ready, error, readNoteContent, writeNoteContent, revealInExplorer, importNote } = useNotes();
  const { importFile } = useFiles(); // for files attachments
  const { links, items: allItems, workspaceId } = useItemStore();
  const loading = !ready;

  const [activeId, setActiveId] = useState<string | null>(focusId || null);
  const [q, setQ] = useState("");
  const [folderFilter, setFolderFilter] = useState<string>("all");
  const [contentHtml, setContentHtml] = useState<string>("");
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [fontSize, setFontSize] = useState<number>(14);

  // Enhancements 8, 9, 10 State
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuPos, setSlashMenuPos] = useState({ top: 0, left: 0 });
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);

  // Enhancements 11, 12 State
  const [showHistory, setShowHistory] = useState(false);
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>([]);

  // Graph state
  const [showGraph, setShowGraph] = useState(false);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showPhysicsPanel, setShowPhysicsPanel] = useState(false);
  const [graphTypeFilter, setGraphTypeFilter] = useState<Set<string>>(new Set(["all"]));
  const [graphPhysics, setGraphPhysics] = useState<GraphPhysics>({ repulsion: 200, attraction: 0.1, gravity: 0.05 });

  // contentHtmlRef: always up-to-date with contentHtml, used by isEditing effect to avoid stale closure
  const contentHtmlRef = useRef<string>("");

  useEffect(() => {
    // Load Mermaid.js for enhancement 9
    if (!document.getElementById("mermaid-script")) {
      const script = document.createElement("script");
      script.id = "mermaid-script";
      script.src = "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js";
      script.async = true;
      script.onload = () => (window as any).mermaid?.initialize({ startOnLoad: false, theme: "dark" });
      document.body.appendChild(script);
    }
  }, []);

  const togglePin = async (e: React.MouseEvent, note: Item) => {
    e.stopPropagation();
    const meta = getNoteMeta(note);
    try { await updateMeta(note.id, { ...meta, pinned: !(meta as any).pinned }); toast((meta as any).pinned ? "Unpinned" : "Pinned to top", "ph-push-pin"); }
    catch (err) { console.error("Failed to pin note:", err); }
  };

  const editorRef = useRef<HTMLDivElement>(null);
  const autosaveTimer = useRef<any>(null);

  // Default selection
  useEffect(() => {
    if (!activeId && notes.length > 0) setActiveId(notes[0].id);
  }, [notes, activeId]);

  useEffect(() => {
    if (focusId) {
      const note = notes.find((n) => n.id === focusId);
      if (note) setActiveId(focusId);
    }
  }, [focusId, notes]);

  // Read-model: folders, filtered+sorted list, and the selected-note projection (meta +
  // links). Filtering/sorting/metadata extraction live in the VM, not render scope.
  const notesVM = useMemo(
    () => createNotesViewModel({ notes, links, allItems, folderFilter, query: q, activeId }),
    [notes, links, allItems, folderFilter, q, activeId],
  );
  const { activeNote, activeMeta: activeNoteMeta, activeLinks: activeNoteLinks } = notesVM;

  const graphVM = useMemo(
    () => createGraphViewModel({ items: allItems, links }, graphTypeFilter),
    [allItems, links, graphTypeFilter]
  );

  // Fetch document content from disk when activeNote changes
  useEffect(() => {
    if (activeNoteMeta?.path) {
      readNoteContent(activeNoteMeta.path)
        .then((html) => {
          setContentHtml(html);
          setAiSummary(null);
          setIsEditing(false);
          // Enhancement 9: Render Mermaid diagrams after load
          setTimeout(() => {
            if ((window as any).mermaid) {
              const nodes = document.querySelectorAll(".note-editor-body pre code.language-mermaid");
              nodes.forEach((node, i) => {
                const id = `mermaid-${activeId}-${i}`;
                const text = node.textContent || "";
                if (!node.parentElement?.querySelector(".mermaid-rendered")) {
                  const div = document.createElement("div");
                  div.className = "mermaid-rendered";
                  div.id = id;
                  div.style.marginTop = "10px";
                  node.parentElement?.appendChild(div);
                  (window as any).mermaid.render(id + "-svg", text).then((res: any) => {
                    div.innerHTML = res.svg;
                  }).catch(console.error);
                }
              });
            }
          }, 300);
        })
        .catch((err) => {
          console.error(err);
          setContentHtml("<h1>Error</h1><p>Could not read note file from disk.</p>");
          setIsEditing(false);
        });
    } else {
      setContentHtml("");
      setAiSummary(null);
      setIsEditing(false);
      setToc([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Enhancement 12: Parse TOC
  useEffect(() => {
    if (!contentHtml) { setToc([]); return; }
    const temp = document.createElement("div");
    temp.innerHTML = contentHtml;
    const headers = Array.from(temp.querySelectorAll("h1, h2, h3"));
    const items = headers.map((h, i) => {
      // Create a basic slug if ID doesn't exist
      const text = h.textContent || "";
      const slug = h.id || "h-" + text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || `h-${i}`;
      return { id: slug, text, level: parseInt(h.tagName[1]) };
    }).filter(i => i.text.trim().length > 0);
    setToc(items);
  }, [contentHtml]);

  // Keep contentHtmlRef in sync so isEditing effect can read latest value without stale closure
  useEffect(() => { contentHtmlRef.current = contentHtml; }, [contentHtml]);

  // Populate editor DOM once when entering edit mode — never re-run while typing
  useEffect(() => {
    if (isEditing && editorRef.current) {
      editorRef.current.innerHTML = contentHtmlRef.current;
      editorRef.current.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  // Clean up autosave on unmount
  useEffect(() => {
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, []);

  const saveContent = async (html: string) => {
    if (!activeNote || !activeNoteMeta?.path) return;
    try {
      await writeNoteContent(activeNote.id, html);
      // update SQLite metadata cache
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = html;
      const plainText = tempDiv.innerText || tempDiv.textContent || "";
      const words = plainText.trim().split(/\s+/).filter(Boolean).length;
      const preview = plainText.trim().slice(0, 140);
      
      // Record a read-only save snapshot (timestamp + preview) — last 5 kept in meta.
      const currentVersions = (activeNoteMeta as any).versions || [];
      const newVersions = [{ date: new Date().toISOString(), preview: preview.slice(0, 50) + "..." }, ...currentVersions].slice(0, 5); // Keep last 5

      await updateMeta(activeNote.id, {
        ...activeNoteMeta,
        words,
        preview,
        full_text: plainText,
        versions: newVersions,
        updated: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
    } catch (e) {
      console.error("Autosave failed:", e);
    }
  };

  const handleInput = () => {
    if (editorRef.current) {
      const html = editorRef.current.innerHTML;
      // Do NOT call setContentHtml here — would trigger React reconcile and reset cursor position.
      // contentHtml is synced from the editor only when leaving edit mode.

      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = setTimeout(() => {
        saveContent(html);
      }, 1500);
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Enhancement 8: Inline Slash Commands
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const node = sel.anchorNode;
      if (node && node.nodeType === 3 && node.textContent?.endsWith("/")) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        setSlashMenuPos({ top: rect.bottom, left: rect.left });
        setSlashMenuOpen(true);
      } else if (e.key === "Escape" || e.key === "Backspace") {
        setSlashMenuOpen(false);
      }
    }
  };

  const handleSlashCommand = (cmd: string) => {
    setSlashMenuOpen(false);
    // Remove the slash
    document.execCommand("delete");
    if (cmd === "h1") document.execCommand("formatBlock", false, "<h1>");
    if (cmd === "h2") document.execCommand("formatBlock", false, "<h2>");
    if (cmd === "ul") document.execCommand("insertUnorderedList");
    if (cmd === "ol") document.execCommand("insertOrderedList");
    if (cmd === "todo") document.execCommand("insertHTML", false, "<input type='checkbox'> ");
    if (cmd === "mermaid") document.execCommand("insertHTML", false, "<pre><code class='language-mermaid'>graph TD;\nA-->B;</code></pre><p><br></p>");
  };

  // Local AI summarization via Ollama (if running). No fabricated fallback — if there
  // is no local model, we say so honestly rather than inventing a summary.
  const handleAISummarize = async () => {
    if (!activeNote) return;
    setIsSummarizing(true);
    try {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = editorRef.current?.innerHTML || contentHtml;
      const plainText = (tempDiv.innerText || "").trim();
      if (!plainText) { setAiSummary("Nothing to summarize yet."); return; }

      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama3", prompt: "Summarize this note briefly:\n\n" + plainText, stream: false })
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json();
        setAiSummary(data.response);
      } else {
        setAiSummary("No local AI model detected. Install and run Ollama (a local 'llama3' model) at localhost:11434 to generate summaries. Nothing was fabricated.");
      }
    } catch (e) {
      console.error(e);
      setAiSummary("Error contacting the local AI model.");
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleNewNote = async () => {
    const r = await modal.form({
      title: "New note", icon: "ph-note-pencil", accent: "var(--h-notes)", submitLabel: "Create note",
      fields: [{ name: "title", label: "Title", placeholder: "Note title…", required: true }],
    });
    if (!r) return;
    try {
      const newItem = await create(r.title);
      setActiveId(newItem.id);
      setIsEditing(true);
      toast("Note created on disk", "ph-note-pencil");
    } catch (err: any) {
      console.error("Failed to create note:", err);
      modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleRenameNote = async () => {
    if (!activeNote) return;
    const r = await modal.form({
      title: "Rename note", icon: "ph-pencil", accent: "var(--h-notes)", submitLabel: "Rename",
      fields: [{ name: "title", label: "New Title", defaultValue: activeNote.title, required: true }],
    });
    if (!r) return;
    try {
      await updateFields(activeNote.id, r.title);
      toast("Note renamed on disk", "ph-pencil");
    } catch (err: any) {
      console.error("Failed to rename note:", err);
      modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleDeleteNote = async () => {
    if (!activeNote) return;
    const ok = await modal.confirm({ title: "Delete note", message: `Delete “${activeNote.title}”? This will remove the file from your disk.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try {
      const itemLinks = links.filter((l) => l.source_id === activeNote.id || l.target_id === activeNote.id);
      await commands.run(deleteCommand(remove, restore, activeNote, itemLinks, "Delete Note")); 
      setActiveId(null);
      toast("Note deleted", "ph-trash", { label: "Undo", onClick: () => commands.undo() });
    } catch (err) { console.error("Failed to delete note:", err); }
  };

  const handleSaveAs = async () => {
    if (!activeNote || !activeNoteMeta?.path) return;
    const dest = await save({
      title: "Save Copy As...",
      defaultPath: `${activeNote.title}_copy.html`,
      filters: [{ name: "HTML Document", extensions: ["html"] }]
    });
    if (!dest) return;
    try {
      await fsCopyFile(activeNoteMeta.path, dest);
      toast("Copy saved successfully", "ph-floppy-disk");
    } catch (err: any) {
      modal.confirm({ title: "Save Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleOpenFolder = () => {
    if (activeNoteMeta?.path) {
      revealInExplorer(activeNoteMeta.path).catch(console.error);
    }
  };

  const handleExportNote = async () => {
    if (!activeNote || !activeNoteMeta?.path) return;
    const dest = await save({
      title: "Export Note",
      defaultPath: `${activeNote.title}.md`,
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "HTML", extensions: ["html"] },
        { name: "Plain Text", extensions: ["txt"] }
      ]
    });
    if (!dest) return;

    const ext = dest.split(".").pop()?.toLowerCase();
    try {
      if (ext === "html") {
        await fsCopyFile(activeNoteMeta.path, dest);
      } else if (ext === "md" || ext === "markdown") {
        const mdContent = htmlToMarkdown(contentHtml);
        await fsWriteAnyFile(dest, mdContent);
      } else {
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = contentHtml;
        const textContent = tempDiv.innerText || tempDiv.textContent || "";
        await fsWriteAnyFile(dest, textContent);
      }
      toast("Note exported successfully", "ph-export");
    } catch (err: any) {
      modal.confirm({ title: "Export Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const runCommand = (command: string, value: string = "") => {
    document.execCommand(command, false, value);
    if (editorRef.current) {
      handleInput();
    }
  };

  const applyFontSize = (size: number) => {
    setFontSize(size);
    document.execCommand("fontSize", false, "7");
    const fontElements = document.querySelectorAll('font[size="7"]');
    fontElements.forEach((el) => {
      const span = document.createElement("span");
      span.style.fontSize = `${size}px`;
      span.innerHTML = el.innerHTML;
      el.parentNode?.replaceChild(span, el);
    });
    if (editorRef.current) {
      handleInput();
    }
  };

  const adjustFontSize = (delta: number) => {
    const fontSizes = [10, 12, 14, 16, 18, 20, 24, 32, 48];
    const currentIndex = fontSizes.indexOf(fontSize);
    let newIndex = currentIndex + delta;
    if (newIndex >= 0 && newIndex < fontSizes.length) {
      applyFontSize(fontSizes[newIndex]);
    }
  };

  const addLink = () => {
    const url = prompt("Enter hyperlink URL:");
    if (url) {
      runCommand("createLink", url);
    }
  };

  const addChecklist = () => {
    runCommand("insertHTML", '<p class="todo-line"><input type="checkbox" style="margin-right: 8px;" /> Todo item</p>');
  };

  const handleAttachFile = async () => {
    const selected = await open({
      multiple: false,
      title: "Select File to Attach"
    });
    if (!selected) return;
    const filePath = Array.isArray(selected) ? selected[0] : selected;
    const filename = filePath.split(/[\/\\]/).pop() || "file";

    const isCopy = await modal.confirm({
      title: "Attach Strategy",
      message: `Attach file: ${filename}\n\nCopy file into Loom or keep it where it is?`,
      icon: "ph-paperclip",
      confirmLabel: "Copy to Loom",
      cancelLabel: "Keep Reference"
    });
    const strat = isCopy ? "copy" : "reference";

    try {
      const imported = await importFile(filePath, strat);
      const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(imported.filename);
      let attachmentHtml = "";

      if (isImage) {
        attachmentHtml = `<img src="${convertFileSrc(imported.path)}" alt="${imported.filename}" style="max-width: 100%; margin: 8px 0; border-radius: var(--r-md); border: 1px solid var(--border);" />`;
      } else {
        attachmentHtml = `<p><a href="#" data-attachment="${imported.path}" class="attachment-card"><i class="ph ph-file-text" style="margin-right: 4px;"></i> ${imported.filename}</a></p>`;
      }

      runCommand("insertHTML", attachmentHtml);
      toast("File attached to note", "ph-paperclip");
    } catch (err: any) {
      modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleAutoTag = async () => {
    if (!activeNote || !activeNoteMeta) return;
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = editorRef.current?.innerHTML || contentHtml;
    const text = (tempDiv.textContent || "").toLowerCase();
    const stopWords = new Set(["the","a","an","and","or","but","in","on","at","to","for","of","with","by","from","is","are","was","were","be","been","have","has","had","do","does","did","will","would","could","should","may","might","this","that","these","those","i","you","he","she","we","they","it","my","your","his","her","our","their","its","as","if","then","than","so","just","not","no","can","also","all","any","some","there","here","what","when","where","who","how","which","about","into","more","its","such","only","over","after","also","because","there","through","during","before","without","under","between","each","more","other","than","both","few","those","same","own","per","while","being","since","against","during","each","further","once"]);
    const words = text.match(/\b[a-z]{4,}\b/g) || [];
    const freq: Record<string, number> = {};
    words.forEach(w => { if (!stopWords.has(w)) freq[w] = (freq[w] || 0) + 1; });
    const topWord = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!topWord) { toast("Not enough content to auto-tag", "ph-tag"); return; }
    try {
      await updateMeta(activeNote.id, { ...activeNoteMeta, tag: topWord });
      toast(`Tag set: #${topWord}`, "ph-tag");
    } catch (e) { console.error("Auto-tag failed:", e); }
  };

  const handlePopout = () => {
    if (!activeNote) return;
    const label = `note-popout-${activeNote.id.slice(0, 8)}`;
    try {
      new WebviewWindow(label, {
        url: `/?view=notes&focus=${activeNote.id}`,
        title: activeNote.title,
        width: 860,
        height: 680,
        center: true,
        resizable: true,
        decorations: true,
      });
    } catch (e) {
      console.error("Pop-out failed:", e);
      toast("Could not open pop-out window", "ph-warning");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (activeNoteMeta?.path) {
        readNoteContent(activeNoteMeta.path)
          .then((html) => {
            setContentHtml(html);
            setIsEditing(false);
            toast("Edits discarded", "ph-x-circle");
          });
      }
    } else if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (editorRef.current) {
        const html = editorRef.current.innerHTML;
        setContentHtml(html);
        saveContent(html).then(() => {
          setIsEditing(false);
          toast("Note saved to disk", "ph-check-circle");
        });
      }
    }
  };

  const handleDropPaths = async (paths: string[]) => {
    for (const p of paths) {
      const ext = p.split(".").pop()?.toLowerCase() || "";
      const isNoteFormat = ["txt", "md", "markdown", "rtf", "docx"].includes(ext);

      if (isNoteFormat) {
        try {
          await importNote(p);
          toast("Document imported as note", "ph-note");
        } catch (err: any) {
          modal.confirm({ title: "Import Error", message: String(err), icon: "ph-warning", danger: true });
        }
      } else {
        if (!activeNote) {
          toast("Select a note first to attach this file.", "ph-warning");
          continue;
        }
        const filename = p.split(/[\/\\]/).pop() || "file";
        const isCopy = await modal.confirm({
          title: "Attach Strategy",
          message: `Attach file: ${filename}\n\nCopy file into Loom or keep it where it is?`,
          icon: "ph-paperclip",
          confirmLabel: "Copy to Loom",
          cancelLabel: "Keep Reference"
        });
        const strat = isCopy ? "copy" : "reference";
        try {
          const imported = await importFile(p, strat);
          const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(imported.filename);
          let attachmentHtml = "";
          if (isImage) {
            attachmentHtml = `<img src="${convertFileSrc(imported.path)}" alt="${imported.filename}" style="max-width: 100%; margin: 8px 0; border-radius: var(--r-md); border: 1px solid var(--border);" />`;
          } else {
            attachmentHtml = `<p><a href="#" data-attachment="${imported.path}" class="attachment-card"><i class="ph ph-file-text" style="margin-right: 4px;"></i> ${imported.filename}</a></p>`;
          }
          if (isEditing && editorRef.current) {
            runCommand("insertHTML", attachmentHtml);
          } else {
            const newHtml = contentHtml + attachmentHtml;
            await writeNoteContent(activeNote.id, newHtml);
            setContentHtml(newHtml);
          }
          toast("File attached to note", "ph-paperclip");
        } catch (err: any) {
          modal.confirm({ title: "Attachment Error", message: String(err), icon: "ph-warning", danger: true });
        }
      }
    }
  };

  useEffect(() => {
    const handleGlobalDrop = (e: Event) => {
      const customEvent = e as CustomEvent;
      const paths = customEvent.detail?.paths;
      if (paths && paths.length > 0) {
        handleDropPaths(paths);
      }
    };
    window.addEventListener("loom-file-drop", handleGlobalDrop);
    return () => {
      window.removeEventListener("loom-file-drop", handleGlobalDrop);
    };
  }, [activeId, workspaceId, contentHtml, isEditing]);

  const handleDocClick = (e: React.MouseEvent) => {
    if (isEditing) return;
    const target = e.target as HTMLElement;
    const link = target.closest("a");
    if (link) {
      const attachmentPath = link.getAttribute("data-attachment");
      if (attachmentPath) {
        e.preventDefault();
        fsOpenFile(attachmentPath).catch(console.error);
      }
    }
  };

  const { folders, list: filtered } = notesVM;

  const fontSizes = [10, 12, 14, 16, 18, 20, 24, 32, 48];

  const ALL_TYPES = ["note", "task", "project", "habit", "calendar", "bookmark", "library", "file"];
  const toggleTypeFilter = (t: string) => {
    setGraphTypeFilter(prev => {
      const next = new Set(prev);
      if (t === "all") return new Set(["all"]);
      next.delete("all");
      if (next.has(t)) { next.delete(t); if (next.size === 0) return new Set(["all"]); }
      else next.add(t);
      return next;
    });
  };

  return (
    <div className="two-pane" style={{ "--mod": "var(--h-notes)", position: "relative" } as any}>
      <div className="pane-list">
        <div className="pane-list-head">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <PageHeadCompact mod="var(--h-notes)" icon="ph-note" title="Notes" count={notes.length} />
            <div className="row gap6">
              <button className={cx("btn icon sm", showGraph && "active")} onClick={() => setShowGraph(!showGraph)} title="Toggle Graph View"><I n="ph-graph" /></button>
              <button className="btn primary sm" onClick={handleNewNote} style={{ whiteSpace: "nowrap" }}><I n="ph-plus" w="bold" /> New note</button>
            </div>
          </div>
          <div className="search-inline" style={{ maxWidth: "none", marginTop: 12 }}>
            <I n="ph-magnifying-glass" /><input placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {folders.length > 1 && (
            <div className="row wrap gap6" style={{ marginTop: 10 }}>
              <button className={cx("chip", folderFilter === "all" && "active")} style={folderFilter === "all" ? { background: "var(--accent-soft)", color: "var(--accent-text)", borderColor: "var(--accent-line)" } : {}} onClick={() => setFolderFilter("all")}>All</button>
              {folders.map((f) => (
                <button key={f} className={cx("chip", folderFilter === f && "active")} style={folderFilter === f ? { background: "var(--accent-soft)", color: "var(--accent-text)", borderColor: "var(--accent-line)" } : {}} onClick={() => setFolderFilter(f)}><I n="ph-folder" /> {f}</button>
              ))}
            </div>
          )}
        </div>
        <motion.div className="pane-list-scroll" variants={listStagger} initial="initial" animate="enter">
          {error ? (
            <div className="muted" style={{ padding: "20px 16px", color: "var(--h-calendar)" }}>Error: {error}</div>
          ) : loading ? (
            <div className="muted" style={{ padding: "20px 16px" }}>Loading notes...</div>
          ) : filtered.length === 0 ? (
            <EmptyState compact icon="ph-note" mod="var(--h-notes)" title={notes.length === 0 ? "No notes yet" : "No notes match your filter"} />
          ) : filtered.map(({ item: n, meta, pinned }) => (
              <motion.div variants={listItem} key={n.id} className={cx("note-card", n.id === activeId && "active")} onClick={() => setActiveId(n.id)} {...clickable(() => setActiveId(n.id))}>
                <div className="nc-t">
                  {pinned && <I n="ph-push-pin" w="fill" style={{ color: "var(--h-notes)", fontSize: "var(--fs-sm)", marginRight: 5 }} />}
                  {n.title}
                  <button className="nc-pin" onClick={(e) => togglePin(e, n)} title={pinned ? "Unpin" : "Pin"} aria-label={pinned ? "Unpin note" : "Pin note"}>
                    <I n="ph-push-pin" w={pinned ? "fill" : "regular"} />
                  </button>
                </div>
                <div className="nc-p">{meta.preview}</div>
                <div className="nc-m">
                  <I n="ph-folder" /> {meta.folder} · <I n="ph-clock" /> {meta.updated} · {meta.words}w
                  {meta.tag && <span className="tag" style={{ marginLeft: "auto" }}>#{meta.tag}</span>}
                </div>
              </motion.div>
          ))}
        </motion.div>
      </div>
      <div className="pane-doc">
        {activeNote && activeNoteMeta ? (
          <div className="doc-pad fade-in" key={activeNote.id}>
            <div className="doc-meta-bar" style={{ flexWrap: "wrap", gap: 10 }}>
              <I n="ph-folder" /> {activeNoteMeta.folder} <span>·</span> <I n="ph-clock" /> Updated {activeNoteMeta.updated} <span>·</span> {activeNoteMeta.words} words
              {activeNoteMeta.tag && <span className="tag">#{activeNoteMeta.tag}</span>}
              <div className="row gap6" style={{ marginLeft: "auto" }}>
                <button className="btn sm" onClick={() => inspect(activeNote.id)}>
                  <I n="ph-graph" /> {activeNoteLinks.length} connections
                </button>
                <button className={cx("btn sm", (activeNoteMeta as any).pinned && "active")} onClick={(e) => togglePin(e, activeNote)} title={(activeNoteMeta as any).pinned ? "Unpin" : "Pin to top"}>
                  <I n="ph-push-pin" w={(activeNoteMeta as any).pinned ? "fill" : "regular"} /> {(activeNoteMeta as any).pinned ? "Pinned" : "Pin"}
                </button>
                <button className="btn sm" onClick={handleRenameNote} title="Rename note">
                  <I n="ph-pencil" /> Rename
                </button>
                <button className="btn sm" onClick={handleOpenFolder} title="Open Containing Folder">
                  <I n="ph-folder-open" /> Reveal
                </button>
                <button className="btn sm" onClick={handlePopout} title="Open in New Window">
                  <I n="ph-app-window" /> Pop-out
                </button>
                <button className="btn sm" onClick={handleSaveAs} title="Save Copy As...">
                  <I n="ph-floppy-disk" /> Save As
                </button>
                <button className="btn sm" onClick={handleExportNote} title="Export Note...">
                  <I n="ph-export" /> Export
                </button>
                <button className={`btn sm ${isEditing ? "active" : ""}`} onClick={() => {
                  if (isEditing && editorRef.current) {
                    setContentHtml(editorRef.current.innerHTML);
                  }
                  setIsEditing(v => !v);
                }}>
                  <I n={isEditing ? "ph-eye" : "ph-pencil-simple"} /> {isEditing ? "View" : "Edit"}
                </button>
                <div style={{ position: "relative" }}>
                  <button className="btn sm" onClick={() => setShowHistory(!showHistory)} title="Version History">
                    <I n="ph-clock-counter-clockwise" /> History
                  </button>
                  {showHistory && (
                    <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: 8, width: 280, zIndex: 100, boxShadow: "var(--shadow-lg)" }}>
                      <div className="mono-sm ghost" style={{ marginBottom: 8, padding: "0 4px" }}>RECENT SAVES (read-only)</div>
                      {((activeNoteMeta as any).versions || []).map((v: any, i: number) => (
                        <div key={i} style={{ padding: "8px", borderBottom: i < ((activeNoteMeta as any).versions.length - 1) ? "1px solid var(--border)" : "none", fontSize: "var(--fs-xs)", borderRadius: "var(--r-sm)" }}>
                          <div style={{ color: "var(--text)" }}>{new Date(v.date).toLocaleString()}</div>
                          <div className="muted">{v.preview}</div>
                        </div>
                      ))}
                      {(!(activeNoteMeta as any).versions || (activeNoteMeta as any).versions.length === 0) && (
                        <div className="muted" style={{ padding: 4, fontSize: "var(--fs-xs)" }}>No history yet.</div>
                      )}
                    </div>
                  )}
                </div>
                <button className="btn icon sm" onClick={handleDeleteNote} title="Delete note"><I n="ph-trash" style={{ color: "var(--text-faint)" }} /></button>
              </div>
            </div>
            
            <div style={{ display: "flex", gap: 32, alignItems: "flex-start", marginTop: 24 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 style={{ marginTop: 0 }}>{activeNote.title}</h1>
                
                {isEditing ? (
              <div className="note-editor-container">
                <div className="note-editor-toolbar">
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("bold"); }} title="Bold"><I n="ph-text-b" w="bold" /></button>
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("italic"); }} title="Italic"><I n="ph-text-italic" w="bold" /></button>
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("underline"); }} title="Underline"><I n="ph-text-underline" w="bold" /></button>
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("strikeThrough"); }} title="Strikethrough"><I n="ph-text-strikethrough" w="bold" /></button>
                  
                  <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }}></div>
                  
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("formatBlock", "<h1>"); }} title="Heading 1"><span style={{ fontWeight: 800 }}>H1</span></button>
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("formatBlock", "<h2>"); }} title="Heading 2"><span style={{ fontWeight: 650 }}>H2</span></button>
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("formatBlock", "<h3>"); }} title="Heading 3"><span style={{ fontWeight: 550 }}>H3</span></button>
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("formatBlock", "<p>"); }} title="Paragraph"><span>P</span></button>
                  
                  <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }}></div>
                  
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("insertUnorderedList"); }} title="Bullet List"><I n="ph-list-bullets" w="bold" /></button>
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("insertOrderedList"); }} title="Numbered List"><I n="ph-list-numbers" w="bold" /></button>
                  <button onMouseDown={(e) => { e.preventDefault(); addChecklist(); }} title="Checklist"><I n="ph-square" w="bold" /></button>
                  
                  <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }}></div>

                  <button onMouseDown={(e) => { e.preventDefault(); addLink(); }} title="Insert Link"><I n="ph-link" w="bold" /></button>
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("unlink"); }} title="Remove Link"><I n="ph-link-break" w="bold" /></button>
                  
                  <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }}></div>

                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("formatBlock", "<blockquote>"); }} title="Blockquote"><I n="ph-quotes" w="bold" /></button>
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("formatBlock", "<pre>"); }} title="Code Block"><I n="ph-code" w="bold" /></button>
                  
                  <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }}></div>

                  <select 
                    value={fontSize} 
                    onChange={(e) => applyFontSize(parseInt(e.target.value))}
                    style={{ background: "var(--surface-2)", color: "var(--text-dim)", border: "1px solid var(--border)", fontSize: "var(--fs-xs)" }}
                  >
                    {fontSizes.map(size => (
                      <option key={size} value={size}>{size}px</option>
                    ))}
                  </select>
                  <button onMouseDown={(e) => { e.preventDefault(); adjustFontSize(1); }} title="Increase Font"><I n="ph-plus-circle" w="bold" /></button>
                  <button onMouseDown={(e) => { e.preventDefault(); adjustFontSize(-1); }} title="Decrease Font"><I n="ph-minus-circle" w="bold" /></button>
                  
                  <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }}></div>
                  
                  <button onMouseDown={(e) => { e.preventDefault(); handleAttachFile(); }} title="Attach File"><I n="ph-paperclip" w="bold" /> Attach</button>

                  <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }}></div>

                  <button onMouseDown={(e) => { e.preventDefault(); handleAISummarize(); }} title="AI Summarize" disabled={isSummarizing}>
                    <I n={isSummarizing ? "ph-spinner" : "ph-magic-wand"} w="bold" /> {isSummarizing ? "Thinking..." : "Summarize"}
                  </button>
                  <button onMouseDown={(e) => { e.preventDefault(); handleAutoTag(); }} title="Auto-Tag from content">
                    <I n="ph-tag" w="bold" /> Auto-Tag
                  </button>
                  
                  <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }}></div>

                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("undo"); }} title="Undo"><I n="ph-arrow-counter-clockwise" w="bold" /></button>
                  <button onMouseDown={(e) => { e.preventDefault(); runCommand("redo"); }} title="Redo"><I n="ph-arrow-clockwise" w="bold" /></button>
                </div>

                {aiSummary && (
                  <div style={{ padding: "12px 16px", background: "var(--surface-2)", borderBottom: "1px solid var(--border)", display: "flex", gap: 12 }}>
                    <I n="ph-magic-wand" style={{ color: "var(--accent)", fontSize: 20, marginTop: 2 }} />
                    <div style={{ flex: 1, fontSize: "var(--fs-sm)", lineHeight: 1.5 }}>
                      <b style={{ color: "var(--text)" }}>AI Summary</b>
                      <div className="muted">{aiSummary}</div>
                    </div>
                    <button className="btn icon sm" onClick={() => setAiSummary(null)}><I n="ph-x" /></button>
                  </div>
                )}

                {slashMenuOpen && (
                  <div 
                    className="slash-menu"
                    style={{ position: "fixed", top: slashMenuPos.top + 5, left: slashMenuPos.left, zIndex: 1000, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", boxShadow: "var(--shadow-md)", padding: "4px", minWidth: 150 }}
                  >
                    <div className="muted" style={{ padding: "4px 8px", fontSize: "var(--fs-xs)", fontWeight: 600 }}>INSERT</div>
                    <button onClick={() => handleSlashCommand("h1")} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", borderRadius: 4 }}><I n="ph-text-h" /> Heading 1</button>
                    <button onClick={() => handleSlashCommand("h2")} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", borderRadius: 4 }}><I n="ph-text-h" /> Heading 2</button>
                    <button onClick={() => handleSlashCommand("ul")} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", borderRadius: 4 }}><I n="ph-list-bullets" /> Bullet List</button>
                    <button onClick={() => handleSlashCommand("todo")} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", borderRadius: 4 }}><I n="ph-square" /> To-Do</button>
                    <button onClick={() => handleSlashCommand("mermaid")} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", borderRadius: 4 }}><I n="ph-code" /> Mermaid Diagram</button>
                  </div>
                )}

                <div
                  ref={editorRef}
                  className="note-editor-body"
                  contentEditable={true}
                  suppressContentEditableWarning={true}
                  onInput={handleInput}
                  onKeyDown={handleKeyDown}
                  onKeyUp={handleKeyUp}
                />
                <div style={{ padding: "6px 16px", background: "var(--surface-2)", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }} className="mono-sm ghost">
                  <span>Double-click note content to edit · Escape to discard · Ctrl+S to save</span>
                  <span>Autosaving...</span>
                </div>
              </div>
            ) : (
              <div 
                className="note-editor-body"
                style={{ padding: "20px 0", cursor: "pointer" }}
                onDoubleClick={() => setIsEditing(true)}
                onClick={handleDocClick}
                dangerouslySetInnerHTML={{ __html: contentHtml || "<p className='muted'>Empty note. Double-click here to write.</p>" }}
              />
            )}

            <div className="divider"></div>
            <h2 style={{ marginTop: 0 }}>Linked</h2>
            <div className="row wrap gap8">{activeNoteLinks.map((it) => <EntityChip key={it.id} id={it.id} sub />)}</div>
          </div>

          {/* Floating TOC */}
          {toc.length > 0 && (
            <div style={{ width: 220, flexShrink: 0, position: "sticky", top: 24, padding: "16px", background: "var(--surface)", borderLeft: "1px solid var(--border)", maxHeight: "calc(100vh - 100px)", overflowY: "auto" }}>
              <div className="mono-sm ghost" style={{ marginBottom: 12 }}><I n="ph-list" /> TABLE OF CONTENTS</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {toc.map((t, i) => (
                  <a 
                    key={i} 
                    href={`#${t.id}`} 
                    onClick={(e) => {
                      // Simple smooth scroll
                      e.preventDefault();
                      const el = document.getElementById(t.id);
                      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                    style={{ 
                      fontSize: "var(--fs-sm)", 
                      color: "var(--text-dim)", 
                      textDecoration: "none",
                      paddingLeft: (t.level - 1) * 12,
                      lineHeight: 1.3
                    }}
                    className="hover-text"
                  >
                    {t.text}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
        </div>
        ) : (
          <div className="doc-pad fade-in">
             <EmptyState icon="ph-note" mod="var(--h-notes)" title="No note selected" sub="Pick a note from the list to read it here." />
          </div>
        )}
      </div>
      {/* Graph overlay — sibling to pane-doc so position:absolute on two-pane works */}
      {showGraph && (
        <div style={{ position: "absolute", inset: 0, zIndex: 50, background: "var(--surface-1)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexShrink: 0 }}>
            <div className="row gap10">
              <I n="ph-graph" style={{ fontSize: 20, color: "var(--accent)" }} />
              <span style={{ fontWeight: 600 }}>Knowledge Graph</span>
              <span className="mono-sm ghost">
                {graphVM.nodeCount} nodes · {graphVM.edgeCount} edges
              </span>
            </div>
            <div className="row gap8" style={{ position: "relative" }}>
              <div style={{ position: "relative" }}>
                <button className={cx("btn sm", showFilterPanel && "active")} onClick={() => { setShowFilterPanel(v => !v); setShowPhysicsPanel(false); }}>
                  <I n="ph-funnel" /> Filter Types
                </button>
                {showFilterPanel && (
                  <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "10px 12px", zIndex: 100, minWidth: 180, boxShadow: "var(--shadow-lg)" }}>
                    <div className="mono-sm ghost" style={{ marginBottom: 8 }}>SHOW NODE TYPES</div>
                    {["all", ...ALL_TYPES].map(t => (
                      <label key={t} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer", fontSize: "var(--fs-sm)" }}>
                        <input type="checkbox" checked={graphTypeFilter.has(t)} onChange={() => toggleTypeFilter(t)} style={{ accentColor: "var(--accent)" }} />
                        {t === "all" ? "All types" : t}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ position: "relative" }}>
                <button className={cx("btn sm", showPhysicsPanel && "active")} onClick={() => { setShowPhysicsPanel(v => !v); setShowFilterPanel(false); }}>
                  <I n="ph-atom" /> Physics
                </button>
                {showPhysicsPanel && (
                  <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "12px 16px", zIndex: 100, minWidth: 220, boxShadow: "var(--shadow-lg)" }}>
                    <div className="mono-sm ghost" style={{ marginBottom: 10 }}>SIMULATION SETTINGS</div>
                    {[
                      { key: "repulsion", label: "Repulsion", min: 50, max: 800, step: 10 },
                      { key: "attraction", label: "Attraction", min: 0.01, max: 0.5, step: 0.01 },
                      { key: "gravity", label: "Gravity", min: 0.01, max: 0.3, step: 0.005 },
                    ].map(({ key, label, min, max, step }) => (
                      <div key={key} style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-sm)", marginBottom: 4 }}>
                          <span>{label}</span>
                          <span className="mono-sm ghost">{graphPhysics[key as keyof GraphPhysics]}</span>
                        </div>
                        <input type="range" min={min} max={max} step={step} value={graphPhysics[key as keyof GraphPhysics]}
                          onChange={e => setGraphPhysics(p => ({ ...p, [key]: parseFloat(e.target.value) }))}
                          style={{ width: "100%", accentColor: "var(--accent)" }} />
                      </div>
                    ))}
                    <button className="btn sm" style={{ width: "100%", marginTop: 4 }}
                      onClick={() => setGraphPhysics({ repulsion: 200, attraction: 0.1, gravity: 0.05 })}>
                      Reset defaults
                    </button>
                  </div>
                )}
              </div>
              <button className="btn icon sm" onClick={() => { setShowGraph(false); setShowFilterPanel(false); setShowPhysicsPanel(false); }}><I n="ph-x" /></button>
            </div>
          </div>
          <div style={{ flex: 1, overflow: "hidden" }} onClick={() => { setShowFilterPanel(false); setShowPhysicsPanel(false); }}>
            <ForceGraphCanvas
              nodes={graphVM.nodes}
              edges={graphVM.edges}
              physics={graphPhysics}
              onNodeClick={id => inspect(id)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---- TIMELINE (projection over SQLite items — not an entity) ----
export function TimelineModule() {
  const { inspect } = useLoom();
  const { items } = useItemStore();
  const [filter, setFilter] = useState("all");
  const [tq, setTq] = useState("");
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

// ---- LIBRARY ----
// Per-type progress unit: [modal label, short suffix shown on cards]
// [singular unit label, short suffix]. Movies are intentionally absent — they track a
// binary watched/completed state, not a count (see isCountProgress / handleProgress).
const UNIT_FOR: Record<string, [string, string]> = {
  anime: ["Episode", "ep"], tv: ["Episode", "ep"],
  manga: ["Chapter", "ch"], manhwa: ["Chapter", "ch"], manhua: ["Chapter", "ch"],
  book: ["Page", "pp"], game: ["Hour", "h"],
};

// Movies don't have a numeric progress axis — they're watched or not.
const isCountProgress = (type: string) => type !== "movie";

// Status choices depend on the media category (watch / read / play).
function statusOptionsFor(type: string): { value: string; label: string }[] {
  if (type === "movie") return [
    { value: "Planned", label: "To Watch" }, { value: "Watching", label: "Watching" },
    { value: "Watched", label: "Watched" }, { value: "Dropped", label: "Dropped" },
  ];
  if (type === "anime" || type === "tv") return [
    { value: "Planned", label: "To Watch" }, { value: "Watching", label: "Watching" },
    { value: "Completed", label: "Finished" }, { value: "Paused", label: "Paused" }, { value: "Dropped", label: "Dropped" },
  ];
  if (type === "game") return [
    { value: "Planned", label: "To Play" }, { value: "Playing", label: "Playing" },
    { value: "Completed", label: "Finished" }, { value: "Paused", label: "Paused" }, { value: "Dropped", label: "Dropped" },
  ];
  return [
    { value: "Planned", label: "To Read" }, { value: "Reading", label: "Reading" },
    { value: "Completed", label: "Finished" }, { value: "Paused", label: "Paused" }, { value: "Dropped", label: "Dropped" },
  ];
}

export function LibraryModule() {
  const { inspect, toast, dragTargetId, setDragTargetId } = useLoom();
  const modal = useModal();
  const commands = useCommands();
  const { items, create, updateMeta, updateFields, remove, restore, ready } = useLibrary();
  const { importFile } = useFiles();
  const { links } = useItemStore();
  const loading = !ready;

  const [cat, setCat] = useState("all");
  const cats: [string, string][] = [
    ["all", "All"], ["anime", "Anime"], ["manga", "Manga"], ["manhwa", "Manhwa"], 
    ["manhua", "Manhua"], ["book", "Books"], ["movie", "Movies"], ["tv", "TV Shows"], ["game", "Games"]
  ];

  const [coverPicker, setCoverPicker] = useState<{ itemId: string, query: string, mediaType: string, candidates: any[], page: number, loading: boolean } | null>(null);

  // Fetch one page of cover candidates and open/update the picker overlay.
  const openCoverPicker = async (itemId: string, query: string, mediaType: string, page: number) => {
    setCoverPicker((prev) => ({ itemId, query, mediaType, candidates: prev?.itemId === itemId ? prev.candidates : [], page, loading: true }));
    try {
      const candidates: any[] = await invoke("fetch_cover_candidates", { query, mediaType, page });
      if ((!candidates || candidates.length === 0) && page > 1) {
        // Ran past the last page — wrap back to the first set.
        const first: any[] = await invoke("fetch_cover_candidates", { query, mediaType, page: 1 });
        setCoverPicker({ itemId, query, mediaType, candidates: first || [], page: 1, loading: false });
        toast("No more covers — back to the first set.", "ph-arrows-clockwise");
        return;
      }
      setCoverPicker({ itemId, query, mediaType, candidates: candidates || [], page, loading: false });
      if (!candidates || candidates.length === 0) toast("No covers found for this title.", "ph-info");
    } catch (err) {
      console.error("Cover search failed:", err);
      setCoverPicker(null);
      toast("Cover search failed. Check your connection.", "ph-warning");
    }
  };

  useEffect(() => {
    const handleGlobalDrop = async (e: Event) => {
      const customEvent = e as CustomEvent;
      const paths = customEvent.detail?.paths;
      if (!paths || paths.length === 0 || !dragTargetId) return;

      const targetId = dragTargetId;
      setDragTargetId(null);

      const p = paths[0];
      const ext = p.split(".").pop()?.toLowerCase() || "";
      const isImage = ["jpg", "jpeg", "png", "webp", "gif", "svg"].includes(ext);

      if (!isImage) {
        toast("Library cover must be an image file (PNG, JPG, etc.).", "ph-warning");
        return;
      }

      const item = items.find(it => it.id === targetId);
      if (!item) return;

      try {
        const imported = await importFile(p, "copy");
        const meta = getLibraryMeta(item);
        await updateMeta(targetId, { ...meta, coverPath: imported.path });
        toast(`Set cover for ${item.title}`, "ph-image");
      } catch (err: any) {
        console.error(err);
        modal.confirm({ title: "Cover Import Error", message: String(err), icon: "ph-warning", danger: true });
      }
    };

    window.addEventListener("loom-file-drop", handleGlobalDrop);
    return () => window.removeEventListener("loom-file-drop", handleGlobalDrop);
  }, [dragTargetId, items, updateMeta, toast, importFile, modal, setDragTargetId]);

  const handleNewItem = async () => {
    const r1 = await modal.form({
      title: "Add Media (Step 1 of 2)", icon: "ph-stack", accent: "var(--h-library)", submitLabel: "Next",
      fields: [
        { name: "title", label: "Title", placeholder: "Title…", required: true },
        { name: "type", label: "Type", type: "select", defaultValue: "book", options: [
          { value: "book", label: "Book", icon: "ph-book-open" },
          { value: "anime", label: "Anime", icon: "ph-television" },
          { value: "manga", label: "Manga", icon: "ph-book" },
          { value: "manhwa", label: "Manhwa", icon: "ph-book" },
          { value: "manhua", label: "Manhua", icon: "ph-book" },
          { value: "movie", label: "Movie", icon: "ph-film-strip" },
          { value: "tv", label: "TV Show", icon: "ph-television" },
          { value: "game", label: "Game", icon: "ph-game-controller" },
        ] },
      ],
    });
    if (!r1) return;
    const { title, type } = r1;

    const statusOptions = statusOptionsFor(type);
    const r2 = await modal.form({
      title: "Add Media (Step 2 of 2)", icon: "ph-stack", accent: "var(--h-library)", submitLabel: "Next — Pick a Cover",
      fields: [
        { name: "status", label: "Status", type: "select", defaultValue: statusOptions[0].value, options: statusOptions },
        { name: "favorite", label: "Favorite", type: "select", defaultValue: "no", options: [{ value: "no", label: "No" }, { value: "yes", label: "⭐ Yes" }] }
      ]
    });
    if (!r2) return;

    try {
      const ICON_FOR: Record<string, string> = { game: "ph-game-controller", anime: "ph-television", manga: "ph-book", book: "ph-book-open", manhwa: "ph-book", manhua: "ph-book", movie: "ph-film-strip", tv: "ph-television" };
      const createdItem = await create(title, {
        mediaType: type, status: r2.status, favorite: r2.favorite === "yes", coverPath: "", notes: "", tags: [], progress: { current: 0, total: 0 }, tracking: {},
        color: "var(--h-library)", icon: ICON_FOR[type] || "ph-book-open"
      });
      toast("Item created. Searching covers…", "ph-magnifying-glass");
      await openCoverPicker(createdItem.id, title, type, 1);
    } catch (err) {
      console.error("Failed to create library item:", err);
    }
  };

  const handlePickCover = async (url: string) => {
    if (!coverPicker) return;
    toast("Downloading cover…", "ph-download");
    try {
        const coverPath: string = await invoke("download_and_cache_cover", { url });
        const item = items.find(it => it.id === coverPicker.itemId);
        if (item) {
            const meta = getLibraryMeta(item);
            await updateMeta(item.id, { ...meta, coverPath });
            toast("Cover saved to your Covers folder.", "ph-check-circle");
        }
    } catch (e) {
        console.error("Cover download failed", e);
        toast("Failed to download cover.", "ph-warning");
    }
    setCoverPicker(null);
  };

  // Re-open the cover search for an existing card (pencil-free cover swap).
  const handleFindCover = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getLibraryMeta(item);
    await openCoverPicker(item.id, item.title, meta.mediaType, 1);
  };

  const handleToggleFavorite = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getLibraryMeta(item);
    try {
      await updateMeta(item.id, { ...meta, favorite: !meta.favorite });
      toast(meta.favorite ? "Removed from favorites" : "Added to favorites", "ph-star");
    } catch (err) { console.error("Failed to toggle favorite:", err); }
  };

  const handleDelete = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const ok = await modal.confirm({ title: "Delete item", message: `Delete “${item.title}”? You can undo right after.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try { 
      const itemLinks = links.filter((l) => l.source_id === item.id || l.target_id === item.id);
      await commands.run(deleteCommand(remove, restore, item, itemLinks, "Delete Item")); 
      toast("Item deleted", "ph-trash", { label: "Undo", onClick: () => commands.undo() });
    } catch (err) { console.error("Failed to delete item:", err); }
  };

  const handleProgress = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getLibraryMeta(item);

    // Movies: no count axis — toggle Watched / To Watch.
    if (!isCountProgress(meta.mediaType)) {
      const watched = meta.status === "Watched";
      try {
        await updateMeta(item.id, {
          ...meta,
          status: watched ? "Planned" : "Watched",
          progress: { current: watched ? 0 : 1, total: 1 },
          tracking: {
            ...meta.tracking,
            lastActivityAt: new Date().toISOString(),
            finishedAt: watched ? undefined : new Date().toISOString(),
          },
        });
        toast(watched ? "Marked as to watch" : "Marked as watched 🎬", "ph-film-strip");
      } catch (err) { console.error("Failed to update movie status:", err); }
      return;
    }

    const [unitLabel] = UNIT_FOR[meta.mediaType] || ["Progress", ""];
    const r = await modal.form({
      title: "Update Progress", icon: "ph-trend-up", accent: "var(--h-library)", submitLabel: "Update",
      fields: [
        { name: "current", label: `Current ${unitLabel.toLowerCase()}`, defaultValue: String(meta.progress.current), type: "text" },
        { name: "total", label: `Total ${unitLabel.toLowerCase()}s (0 if unknown)`, defaultValue: String(meta.progress.total), type: "text" }
      ]
    });
    if (!r) return;
    const current = Math.max(0, parseInt(r.current, 10) || 0);
    const total = Math.max(0, parseInt(r.total, 10) || 0);

    let newStatus = meta.status;
    if (total > 0 && current >= total && meta.status !== "Completed") {
      newStatus = "Completed";
    }

    try {
      await updateMeta(item.id, {
        ...meta, progress: { current, total }, status: newStatus,
        tracking: {
          ...meta.tracking,
          lastActivityAt: new Date().toISOString(),
          finishedAt: newStatus === "Completed" ? new Date().toISOString() : meta.tracking.finishedAt,
        },
      });
      if (newStatus !== meta.status) toast(`Marked as ${newStatus} 🎉`, "ph-confetti");
    }
    catch (err) { console.error("Failed to update progress:", err); }
  };

  const handleEdit = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getLibraryMeta(item);
    const statusOptions = statusOptionsFor(meta.mediaType);
    const r = await modal.form({
      title: "Edit item", icon: "ph-pencil", accent: "var(--h-library)", submitLabel: "Save changes",
      fields: [
        { name: "title", label: "Title", defaultValue: item.title, required: true },
        { name: "status", label: "Status", type: "select", defaultValue: meta.status, options: statusOptions },
        { name: "rating", label: "Rating", type: "select", defaultValue: String(meta.rating || 0), options: [
          { value: "0", label: "Unrated" }, ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}/10 ${"★".repeat(Math.round((i + 1) / 2))}` })),
        ] },
        { name: "favorite", label: "Favorite", type: "select", defaultValue: meta.favorite ? "yes" : "no", options: [{ value: "no", label: "No" }, { value: "yes", label: "⭐ Yes" }] },
        { name: "tag", label: "Tags (comma separated)", defaultValue: meta.tags.join(", "), placeholder: "e.g. Action, Sci-Fi" },
      ],
    });
    if (!r) return;
    try {
      if (r.title !== item.title) await updateFields(item.id, r.title, "library");
      const tags = r.tag.split(",").map(t => t.trim()).filter(Boolean);
      await updateMeta(item.id, { ...meta, tags, status: r.status, favorite: r.favorite === "yes", rating: parseInt(r.rating, 10) || 0 });
      toast("Item updated", "ph-check-circle");
    } catch (err) { console.error("Failed to edit library item:", err); }
  };

  const toggleQueue = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getLibraryMeta(item);
    try { await updateMeta(item.id, { ...meta, queue: !meta.queue }); toast(meta.queue ? "Removed from Up Next" : "Added to Up Next", "ph-list-plus"); }
    catch (err) { console.error("Failed to toggle queue:", err); }
  };

  // Read-model: status shelves (category-filtered) with per-card progress/label derived.
  const libraryVM = useMemo(() => createLibraryViewModel({ items, cat }), [items, cat]);

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-library)" } as any}>
      <PageHead mod="var(--h-library)" icon="ph-stack" kicker="Library" title="Media tracking"
        sub="Books, anime, manga, movies, tv, and games — tracked accurately.">
        <div className="seg" style={{ flexWrap: "wrap", marginBottom: 8 }}>{cats.map(([k, l]) => <button key={k} className={cx(cat === k && "on")} onClick={() => setCat(k)}>{l}</button>)}</div>
        <button className="btn primary" onClick={handleNewItem}><I n="ph-plus" w="bold" /> Add Media</button>
      </PageHead>
      
      {coverPicker && (
        <div className="cover-picker-scrim" onClick={() => setCoverPicker(null)}>
          <div className="cover-picker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Select a cover">
            <div className="cover-picker-head">
              <div className="modal-ico" style={{ "--mod": "var(--h-library)" } as any}><I n="ph-image" w="fill" /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "var(--fs-base)" }}>Pick a cover for “{coverPicker.query}”</div>
                <div className="ghost mono-sm" style={{ fontSize: "var(--fs-2xs)" }}>Set {coverPicker.page} · saved locally to your Covers folder</div>
              </div>
              <button className="btn sm" onClick={() => openCoverPicker(coverPicker.itemId, coverPicker.query, coverPicker.mediaType, coverPicker.page + 1)} disabled={coverPicker.loading} title="Fetch a different set of covers">
                <I n="ph-arrows-clockwise" /> Refresh
              </button>
              <button className="btn icon sm" onClick={() => setCoverPicker(null)} title="Skip — keep default cover" aria-label="Close cover picker"><I n="ph-x" /></button>
            </div>
            <div className="cover-picker-grid">
              {coverPicker.loading
                ? Array.from({ length: 10 }).map((_, i) => <div key={i} className="skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--r-md)" }} />)
                : coverPicker.candidates.map((c, i) => (
                  <button key={i} className="cover-option" onClick={() => handlePickCover(c.url)} title={c.title}>
                    <img src={c.url} loading="lazy" alt={c.title} />
                    <span>{c.title}</span>
                  </button>
                ))}
              {!coverPicker.loading && coverPicker.candidates.length === 0 && (
                <div className="muted" style={{ gridColumn: "1 / -1", textAlign: "center", padding: 30 }}>No covers found. Try Refresh or close to keep the default.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="muted" style={{ padding: "20px 0" }}>Loading library...</div>
      ) : items.length === 0 ? (
        <EmptyState icon="ph-stack" mod="var(--h-library)" title="No library items yet" sub="Add a book, game, or series to start a shelf.">
          <button className="btn primary sm" style={{ marginTop: 12 }} onClick={handleNewItem}><I n="ph-plus" w="bold" /> Add media</button>
        </EmptyState>
      ) : libraryVM.shelves.map((sh) => (
          <div className="shelf" key={sh.title}>
            <div className="shelf-head"><span className="st">{sh.title}</span><span className="sc">{sh.items.length}</span></div>
            <motion.div className="shelf-grid" variants={listStagger} initial="initial" animate="enter">
              {sh.items.map(({ id, title, item, meta, isMovie, perc, progLabel }) => (
                  <motion.div
                    variants={listItem}
                    key={id}
                    className={cx("media-card", dragTargetId === id && "drag-target-hover")}
                    style={{ "--mod": meta.color, position: "relative" } as any}
                    onClick={() => inspect(id)}
                    {...clickable(() => inspect(id))}
                    onDragOver={(e) => { e.preventDefault(); if (dragTargetId !== id) setDragTargetId(id); }}
                    onDragLeave={() => { if (dragTargetId === id) setDragTargetId(null); }}
                  >
                    <div className="mc-actions">
                      <button className="btn icon sm" onClick={(e) => toggleQueue(e, item)} title={meta.queue ? "Remove from Up Next" : "Add to Up Next"}>
                        <I n={meta.queue ? "ph-check-circle" : "ph-list-plus"} w={meta.queue ? "fill" : "regular"} style={{ color: meta.queue ? "var(--h-library)" : "var(--text-faint)" }} />
                      </button>
                      <button className="btn icon sm" onClick={(e) => handleToggleFavorite(e, item)} title={meta.favorite ? "Unfavorite" : "Favorite"}>
                        <I n="ph-star" w={meta.favorite ? "fill" : "regular"} style={{ color: meta.favorite ? "var(--sys-star)" : "var(--text-faint)" }} />
                      </button>
                      <button className="btn icon sm" onClick={(e) => handleFindCover(e, item)} title="Change cover (search the web)">
                        <I n="ph-image" style={{ color: "var(--text-faint)" }} />
                      </button>
                      <button className="btn icon sm" onClick={(e) => handleEdit(e, item)} title="Edit">
                        <I n="ph-pencil" style={{ color: "var(--text-faint)" }} />
                      </button>
                      <button className="btn icon sm" onClick={(e) => handleDelete(e, item)} title="Delete">
                        <I n="ph-trash" style={{ color: "var(--text-faint)" }} />
                      </button>
                    </div>
                    <div className="cover" style={meta.coverPath ? { backgroundImage: `url(${convertFileSrc(meta.coverPath)})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
                      {!meta.coverPath && <div className="ph-stripe"></div>}
                      {!meta.coverPath && <div className="cover-ico"><I n={meta.icon as string} w="fill" /></div>}
                      <span className="cover-tag">{meta.mediaType}</span>
                      {meta.rating > 0 && <span className="cover-tag" style={{ left: "auto", right: 6, bottom: 6, top: "auto", background: "rgba(0,0,0,0.65)", color: "var(--sys-star)", fontWeight: 600 }}><I n="ph-star" w="fill" /> {meta.rating}</span>}
                      {meta.tags && meta.tags.length > 0 && <span className="cover-tag" style={{ left: "auto", right: 6, background: "var(--accent)" }}>#{meta.tags[0]}</span>}
                      {meta.favorite && <span className="cover-tag" style={{ top: 6, bottom: "auto", right: 6, background: "transparent", color: "var(--sys-star)", fontSize: 16 }}><I n="ph-star" w="fill" /></span>}
                    </div>
                    <div className="mc-t">{title}</div>
                    <div className="mc-s">{meta.status}</div>
                    <div className="mc-prog" onClick={(e) => handleProgress(e, item)} {...clickable(() => handleProgress({ stopPropagation: () => {} } as any, item))} style={{ cursor: "pointer" }} title={isMovie ? "Toggle watched" : "Update progress"}>
                      <div className="pl"><span>{progLabel}</span><span>{isMovie ? "" : (meta.progress.total > 0 ? perc + "%" : "")}</span></div>
                      <div className="bar"><i style={{ width: perc + "%" }}></i></div>
                    </div>
                  </motion.div>
              ))}
            </motion.div>
          </div>
      ))}
    </div>
  );
}


// ---- VAULT (rows live in SQLite as item_type "vault") ----
export function VaultModule() {
  const { toast } = useLoom();
  const modal = useModal();
  const commands = useCommands();
  const { items, create, updateMeta, updateFields, remove, restore, ready } = useVault();
  const { links, items: allItems, isVaultUnlocked } = useItemStore();

  const [hasMasterPassword, setHasMasterPassword] = useState<boolean | null>(null);
  const [passwordInput, setPasswordInput] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  // Read-model: credential rows (meta + live link count). No decryption here — the
  // encrypted secret stays opaque until vaultSession unlocks it in handleViewDetails.
  const { list } = useMemo(() => createVaultViewModel({ items, links, allItems }), [items, links, allItems]);

  useEffect(() => {
    getSetting("vault_verification")
      .then((val) => {
        setHasMasterPassword(!!val);
      })
      .catch(console.error);
  }, []);

  const handleSetUpMaster = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordInput.trim()) return;
    try {
      const verif = await encryptVaultValue("verification_token", passwordInput);
      await setSetting("vault_verification", verif);
      vaultSession.unlock(passwordInput);
      setHasMasterPassword(true);
      setErrorMsg("");
      setPasswordInput("");
    } catch (err: any) {
      setErrorMsg(String(err));
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const verif = await getSetting("vault_verification");
      if (!verif) {
        setHasMasterPassword(false);
        return;
      }
      const decrypted = await decryptVaultValue(verif, passwordInput);
      if (decrypted === "verification_token") {
        vaultSession.unlock(passwordInput);
        setErrorMsg("");
        setPasswordInput("");
      } else {
        setErrorMsg("Incorrect master password.");
      }
    } catch (err: any) {
      setErrorMsg("Incorrect master password.");
    }
  };

  const handleAdd = async () => {
    if (!isVaultUnlocked) return;
    const r = await modal.form({
      title: "Add Vault Credential",
      icon: "ph-shield-plus",
      accent: "var(--h-vault)",
      submitLabel: "Create",
      fields: [
        { name: "title", label: "Title", placeholder: "e.g., GitHub Personal Token", required: true },
        {
          name: "kind",
          label: "Kind",
          type: "select",
          defaultValue: "API key",
          options: [
            { value: "API key", label: "API Key" },
            { value: "Login", label: "Login" },
            { value: "SSH key", label: "SSH Key" },
            { value: "Secure note", label: "Secure Note" },
            { value: "Password", label: "Password" }
          ]
        },
        { name: "secret", label: "Secret / Password", type: "password", required: true, placeholder: "Enter secret value to encrypt" }
      ]
    });
    if (!r) return;

    try {
      const password = vaultSession.access();
      const encrypted = await encryptVaultValue(r.secret, password);
      let icon = "ph-shield-check";
      if (r.kind === "API key") icon = "ph-key";
      if (r.kind === "Login") icon = "ph-user-focus";
      if (r.kind === "SSH key") icon = "ph-terminal";
      if (r.kind === "Password") icon = "ph-lock-key";

      await create(r.title, {
        kind: r.kind,
        icon,
        color: "var(--h-vault)",
        updated: "Just now",
        secret: encrypted
      });
      toast("Credential added securely", "ph-check-circle");
    } catch (err) {
      console.error(err);
      toast("Failed to create credential", "ph-warning");
    }
  };

  const handleEdit = async (item: Item, meta: any, currentSecret: string) => {
    if (!isVaultUnlocked) return;
    const r = await modal.form({
      title: "Edit Vault Credential",
      icon: "ph-pencil",
      accent: "var(--h-vault)",
      submitLabel: "Save changes",
      fields: [
        { name: "title", label: "Title", defaultValue: item.title, required: true },
        {
          name: "kind",
          label: "Kind",
          type: "select",
          defaultValue: meta.kind || "API key",
          options: [
            { value: "API key", label: "API Key" },
            { value: "Login", label: "Login" },
            { value: "SSH key", label: "SSH Key" },
            { value: "Secure note", label: "Secure Note" },
            { value: "Password", label: "Password" }
          ]
        },
        { name: "secret", label: "Secret / Password", type: "password", defaultValue: currentSecret, required: true }
      ]
    });
    if (!r) return;

    try {
      const password = vaultSession.access();
      const encrypted = await encryptVaultValue(r.secret, password);
      let icon = meta.icon || "ph-shield-check";
      if (r.kind === "API key") icon = "ph-key";
      if (r.kind === "Login") icon = "ph-user-focus";
      if (r.kind === "SSH key") icon = "ph-terminal";
      if (r.kind === "Password") icon = "ph-lock-key";

      if (r.title !== item.title) {
        await updateFields(item.id, r.title, "vault");
      }
      await updateMeta(item.id, {
        ...meta,
        kind: r.kind,
        icon,
        updated: "Updated just now",
        secret: encrypted
      });
      toast("Credential updated securely", "ph-check-circle");
    } catch (err) {
      console.error(err);
      toast("Failed to update credential", "ph-warning");
    }
  };

  const handleViewDetails = async (item: Item) => {
    if (!isVaultUnlocked) return;
    const meta = getVaultMeta(item);

    let secret = "";
    if (meta.secret) {
      try {
        const password = vaultSession.access();
        secret = await decryptVaultValue(meta.secret, password);
      } catch (err) {
        secret = "Failed to decrypt secret.";
      }
    }

    const ok = await modal.confirm({
      title: item.title,
      icon: meta.icon || "ph-shield-check",
      confirmLabel: "Done",
      cancelLabel: "Edit",
      message: (
        <div className="col gap12" style={{ padding: "10px 0" }}>
          <div>
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)" }}>Kind</span>
            <div style={{ fontSize: "var(--fs-sm)", fontWeight: 550 }}>{meta.kind}</div>
          </div>
          <div>
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)" }}>Secret / Password</span>
            <div className="row gap8" style={{ alignItems: "center", marginTop: 4 }}>
              <input
                type="password"
                value={secret}
                readOnly
                style={{ ...fld, flex: 1, fontFamily: "monospace" }}
                onClick={(e) => {
                  const target = e.target as HTMLInputElement;
                  target.type = target.type === "password" ? "text" : "password";
                }}
                title="Click to toggle visibility"
              />
              <button
                className="btn sm"
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(secret);
                  toast("Copied — clipboard clears in 20s", "ph-clipboard");
                  // Don't leave the plaintext secret on the OS clipboard indefinitely.
                  setTimeout(() => {
                    navigator.clipboard.readText()
                      .then((cur) => { if (cur === secret) navigator.clipboard.writeText(""); })
                      .catch(() => {});
                  }, 20000);
                }}
              >
                Copy
              </button>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <button
              className="btn sm danger"
              type="button"
              onClick={async () => {
                const confirmDelete = window.confirm(`Are you sure you want to delete ${item.title}?`);
                if (confirmDelete) {
                  try {
                    const itemLinks = links.filter((l) => l.source_id === item.id || l.target_id === item.id);
                    await commands.run(deleteCommand(remove, restore, item, itemLinks, "Delete Vault Item"));
                  } catch (err) {
                    console.error(err);
                  }
                }
              }}
            >
              Delete Item
            </button>
          </div>
        </div>
      )
    });

    if (ok === false) {
      handleEdit(item, meta, secret);
    }
  };

  if (!ready || hasMasterPassword === null) {
    return (
      <div className="content-pad fade-in" style={{ "--mod": "var(--h-vault)" } as any}>
        <PageHead mod="var(--h-vault)" icon="ph-vault" kicker="Vault" title="Secure vault" />
        <div className="muted" style={{ padding: "20px 0" }}>Loading vault...</div>
      </div>
    );
  }

  if (hasMasterPassword === false) {
    return (
      <div className="content-pad fade-in" style={{ "--mod": "var(--h-vault)" } as any}>
        <PageHead mod="var(--h-vault)" icon="ph-vault" kicker="Vault" title="Secure vault" />
        <div className="col gap12" style={{ maxWidth: 360, margin: "40px auto", padding: 24, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)" }}>
          <div style={{ textAlign: "center", marginBottom: 16 }}>
            <div className="vault-ico" style={{ width: 48, height: 48, margin: "0 auto 12px", borderRadius: "50%", background: "color-mix(in oklch, var(--h-vault) 15%, transparent)", color: "var(--h-vault)", display: "grid", placeItems: "center", fontSize: "24px" }}>
              <I n="ph-shield-check" w="fill" />
            </div>
            <h3 style={{ fontSize: "var(--fs-lg)", fontWeight: 600 }}>Set up Master Password</h3>
            <p className="muted" style={{ fontSize: "var(--fs-xs)", marginTop: 4 }}>Choose a strong password to encrypt your vault credentials at rest.</p>
          </div>
          <form onSubmit={handleSetUpMaster} className="col gap12">
            <input
              type="password"
              placeholder="New Master Password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              style={fld}
              autoFocus
            />
            {errorMsg && <div style={{ color: "var(--danger)", fontSize: "var(--fs-xs)" }}><I n="ph-warning-circle" /> {errorMsg}</div>}
            <button type="submit" className="btn primary" style={{ width: "100%", justifyContent: "center" }}>Set Password</button>
          </form>
        </div>
      </div>
    );
  }

  if (!isVaultUnlocked) {
    return (
      <div className="content-pad fade-in" style={{ "--mod": "var(--h-vault)" } as any}>
        <PageHead mod="var(--h-vault)" icon="ph-vault" kicker="Vault" title="Secure vault" />
        <div className="col gap12" style={{ maxWidth: 360, margin: "40px auto", padding: 24, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)" }}>
          <div style={{ textAlign: "center", marginBottom: 16 }}>
            <div className="vault-ico" style={{ width: 48, height: 48, margin: "0 auto 12px", borderRadius: "50%", background: "color-mix(in oklch, var(--h-vault) 15%, transparent)", color: "var(--h-vault)", display: "grid", placeItems: "center", fontSize: "24px" }}>
              <I n="ph-lock-key" w="fill" />
            </div>
            <h3 style={{ fontSize: "var(--fs-lg)", fontWeight: 600 }}>Unlock Vault</h3>
            <p className="muted" style={{ fontSize: "var(--fs-xs)", marginTop: 4 }}>Enter your Master Password to access credentials.</p>
          </div>
          <form onSubmit={handleUnlock} className="col gap12">
            <input
              type="password"
              placeholder="Master Password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              style={fld}
              autoFocus
            />
            {errorMsg && <div style={{ color: "var(--danger)", fontSize: "var(--fs-xs)" }}><I n="ph-warning-circle" /> {errorMsg}</div>}
            <button type="submit" className="btn primary" style={{ width: "100%", justifyContent: "center" }}>Unlock</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-vault)" } as any}>
      <PageHead mod="var(--h-vault)" icon="ph-vault" kicker="Vault" title="Secure vault"
        sub="A registry of credentials, keys, and secure notes — titles and links, organised in one place.">
        <button className="btn outline" onClick={() => { vaultSession.lock(); setPasswordInput(""); }}><I n="ph-lock" /> Lock Vault</button>
        <button className="btn primary" onClick={handleAdd}><I n="ph-plus" w="bold" /> Add credential</button>
      </PageHead>
      <div className="vault-banner">
        <I n="ph-info" w="fill" />
        <div style={{ flex: 1 }}>
          <b>Reference registry.</b>{" "}
          <span className="muted">This catalogues your secure items and their links. To store an encrypted value on disk, attach a file and encrypt it from the Files module.</span>
        </div>
      </div>
      {list.length === 0 ? (
        <EmptyState icon="ph-lock-key" mod="var(--h-vault)" title="No vault entries yet" sub="Catalogue a credential or secure note here." />
      ) : (
        <motion.div className="vault-grid" variants={listStagger} initial="initial" animate="enter">
          {list.map(({ item, meta, linkCount }) => (
            <motion.div variants={listItem} key={item.id} className="vault-card" style={{ "--mod": meta.color } as any} onClick={() => handleViewDetails(item)} {...clickable(() => handleViewDetails(item))}>
              <div className="vault-ico"><I n={meta.icon || "ph-shield-check"} w="fill" /></div>
              <div className="vault-main">
                <div className="vault-t">{item.title}</div>
                <div className="vault-s">{meta.kind}</div>
              </div>
              {linkCount > 0 && <span className="mono-sm ghost" title={linkCount + " links"}><I n="ph-link" /> {linkCount}</span>}
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// AUTOMATION — real event-driven engine front-end.
// Rules live in SQLite (item_type 'automation', rule JSON in metadata). The Rust
// engine executes them; this UI builds rules, runs them manually, and reads the
// persisted automation_executions history. No fake counters — runs/last-run come
// straight from the engine.
// ════════════════════════════════════════════════════════════════════════════

const fld: React.CSSProperties = {
  background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)",
  color: "var(--text)", padding: "7px 10px", fontSize: "var(--fs-sm)", width: "100%",
};
const lbl: React.CSSProperties = { fontSize: "var(--fs-sm)", color: "var(--text-faint)", marginBottom: 4, display: "block" };

function StatusPill({ s }: { s: string }) {
  const map: Record<string, [string, string]> = {
    SUCCESS: ["var(--h-habits)", "ph-check-circle"],
    FAILED: ["var(--danger)", "ph-x-circle"],
    PARTIAL: ["oklch(0.75 0.15 75)", "ph-warning-circle"],
    SKIPPED: ["var(--text-faint)", "ph-minus-circle"],
    RUNNING: ["var(--h-automation)", "ph-spinner"],
  };
  const [c, i] = map[s] || ["var(--text-faint)", "ph-circle"];
  return <span className="mono-sm" style={{ color: c, display: "inline-flex", alignItems: "center", gap: 4 }}><I n={i} w="fill" /> {s}</span>;
}

// ── Execution history + inspector ─────────────────────────────────────────────
function ExecutionHistory({ automationId, title, onBack }: { automationId?: string; title: string; onBack: () => void }) {
  const [rows, setRows] = useState<ExecutionRow[] | null>(null);
  const [sel, setSel] = useState<ExecutionRow | null>(null);
  const [filter, setFilter] = useState<string>("ALL");

  const load = useCallback(() => {
    getAutomationExecutions(automationId, 200).then(setRows).catch((e) => { console.error(e); setRows([]); });
  }, [automationId]);
  useEffect(() => { load(); }, [load]);

  const view = filterExecutions(rows, filter);

  return (
    <div className="col gap16">
      <div className="row gap8" style={{ alignItems: "center" }}>
        <button className="btn sm" onClick={onBack}><I n="ph-arrow-left" /> Back</button>
        <h2 style={{ fontSize: "var(--fs-lg)", fontWeight: 600, flex: 1 }}>History · {title}</h2>
        <select style={{ ...fld, width: 140 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          {["ALL", "SUCCESS", "FAILED", "PARTIAL", "SKIPPED", "RUNNING"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn sm" onClick={load}><I n="ph-arrows-clockwise" /> Refresh</button>
      </div>
      {rows === null ? <div className="muted">Loading…</div>
        : view.length === 0 ? <EmptyState icon="ph-clock-counter-clockwise" mod="var(--h-automation)" title="No runs yet" sub="Run the automation or wait for its trigger to fire." />
        : (
          <div className="col gap6">
            {view.map((r) => (
              <div key={r.id}>
                <div className="row gap12" style={{ ...fld, cursor: "pointer", alignItems: "center" }}
                  onClick={() => setSel(sel?.id === r.id ? null : r)}>
                  <StatusPill s={r.status} />
                  <span className="mono-sm ghost" style={{ flex: 1 }}>{r.trigger_source}</span>
                  <span className="mono-sm ghost">{r.actions_executed} act</span>
                  <span className="mono-sm ghost">{r.duration_ms != null ? `${r.duration_ms}ms` : "—"}</span>
                  <span className="mono-sm ghost">{new Date(r.started_at).toLocaleString()}</span>
                  <I n={sel?.id === r.id ? "ph-caret-up" : "ph-caret-down"} />
                </div>
                {sel?.id === r.id && (
                  <div style={{ ...fld, marginTop: 4, background: "var(--surface-1)" }}>
                    {r.error && <div style={{ color: "var(--danger)", marginBottom: 8 }}><I n="ph-warning" /> {r.error}</div>}
                    <div className="mono-sm" style={{ whiteSpace: "pre-wrap", color: "var(--text-faint)" }}>
                      {(() => { try { return JSON.stringify(JSON.parse(r.output || "[]"), null, 2); } catch { return r.output || "—"; } })()}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Rule builder ──────────────────────────────────────────────────────────────
function AutomationBuilder({ existing, options, onCancel, onSave }:
  { existing: { item: Item; meta: any } | null; options: { id: string; title: string }[];
    onCancel: () => void; onSave: (title: string, meta: any) => Promise<void> }) {
  const m0 = existing?.meta;
  const [title, setTitle] = useState(existing?.item.title || "");
  const [desc, setDesc] = useState(m0?.desc || "");
  const [on, setOn] = useState(m0?.on ?? true);
  const [trigger, setTrigger] = useState<any>(m0?.trigger || { type: "event", event: "TaskCompleted", entityType: "" });
  const [groupOp, setGroupOp] = useState<string>(m0?.conditions?.op || "AND");
  const [conds, setConds] = useState<any[]>(m0?.conditions?.rules || []);
  const [actions, setActions] = useState<any[]>(m0?.actions || [{ type: "notify", message: "Triggered" }]);
  const [err, setErr] = useState<string | null>(null);

  const setTrig = (k: string, v: any) => setTrigger((t: any) => ({ ...t, [k]: v }));
  const setAct = (i: number, k: string, v: any) => setActions((a) => a.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const setCond = (i: number, k: string, v: any) => setConds((c) => c.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const moveAct = (i: number, d: number) => setActions((a) => {
    const j = i + d; if (j < 0 || j >= a.length) return a;
    const n = [...a];[n[i], n[j]] = [n[j], n[i]]; return n;
  });

  const save = async () => {
    if (!title.trim()) { setErr("Name is required"); return; }
    const t: any = { type: trigger.type };
    if (trigger.type === "event") { t.event = trigger.event; if (trigger.entityType) t.entityType = trigger.entityType; }
    if (trigger.type === "interval") t.intervalSecs = Math.max(60, Math.round((Number(trigger.minutes) || 5) * 60));
    if (trigger.type === "daily") t.time = trigger.time || "08:00";
    const conditions = conds.length ? { op: groupOp, rules: conds } : null;
    const meta = {
      ...(m0 || {}),
      on, color: "var(--h-automation)", desc, runs: m0?.runs || 0,
      trigger: t, conditions, actions,
    };
    try { await onSave(title.trim(), meta); } catch (e: any) { setErr(e?.message || String(e)); }
  };

  const otherAutos = options.filter((a) => a.id !== existing?.item.id);

  return (
    <div className="col gap16" style={{ maxWidth: 760 }}>
      <div className="row gap8" style={{ alignItems: "center" }}>
        <button className="btn sm" onClick={onCancel}><I n="ph-arrow-left" /> Back</button>
        <h2 style={{ fontSize: "var(--fs-lg)", fontWeight: 600, flex: 1 }}>{existing ? "Edit" : "New"} automation</h2>
        <Switch.Root className="rx-switch" checked={on} onCheckedChange={setOn} aria-label="enabled">
          <Switch.Thumb className="rx-switch-thumb" />
        </Switch.Root>
        <span className="mono-sm ghost">{on ? "enabled" : "disabled"}</span>
      </div>

      <div><label style={lbl}>Name *</label><input style={fld} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Task done → log to timeline" /></div>
      <div><label style={lbl}>Description</label><textarea style={{ ...fld, minHeight: 56 }} value={desc} onChange={(e) => setDesc(e.target.value)} /></div>

      {/* TRIGGER */}
      <div style={{ ...fld, padding: 14 }}>
        <div className="row gap8" style={{ marginBottom: 10 }}><I n="ph-flag" style={{ color: "var(--h-automation)" }} /><b>When (trigger)</b></div>
        <div className="row gap6" style={{ marginBottom: 10, flexWrap: "wrap" }}>
          {["event", "interval", "daily", "manual"].map((tt) => (
            <button key={tt} className={cx("btn sm", trigger.type === tt && "primary")} onClick={() => setTrig("type", tt)}>{tt}</button>
          ))}
        </div>
        {trigger.type === "event" && (
          <div className="row gap8">
            <div style={{ flex: 1 }}><label style={lbl}>Event</label>
              <select style={fld} value={trigger.event || ""} onChange={(e) => setTrig("event", e.target.value)}>
                {EVENT_TYPES.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}><label style={lbl}>Entity type (optional)</label>
              <select style={fld} value={trigger.entityType || ""} onChange={(e) => setTrig("entityType", e.target.value)}>
                <option value="">any</option>
                {ENTITY_TYPES.map((et) => <option key={et} value={et}>{et}</option>)}
              </select>
            </div>
          </div>
        )}
        {trigger.type === "interval" && (
          <div><label style={lbl}>Every N minutes (min 1)</label>
            <input style={fld} type="number" min={1} value={trigger.minutes ?? (trigger.intervalSecs ? trigger.intervalSecs / 60 : 5)} onChange={(e) => setTrig("minutes", e.target.value)} /></div>
        )}
        {trigger.type === "daily" && (
          <div><label style={lbl}>Time (24h)</label><input style={fld} type="time" value={trigger.time || "08:00"} onChange={(e) => setTrig("time", e.target.value)} /></div>
        )}
        {trigger.type === "manual" && <div className="muted">Fires only when you press “Run now”.</div>}
      </div>

      {/* CONDITIONS */}
      <div style={{ ...fld, padding: 14 }}>
        <div className="row gap8" style={{ marginBottom: 10 }}>
          <I n="ph-funnel" style={{ color: "var(--h-automation)" }} /><b>If (conditions)</b>
          <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>— all/any must match</span>
          <div style={{ flex: 1 }} />
          <select style={{ ...fld, width: 90 }} value={groupOp} onChange={(e) => setGroupOp(e.target.value)}>
            {["AND", "OR", "NOT"].map((o) => <option key={o}>{o}</option>)}
          </select>
        </div>
        {conds.length === 0 && <div className="muted" style={{ marginBottom: 8 }}>No conditions — runs every time the trigger fires.</div>}
        <div className="col gap6">
          {conds.map((c, i) => (
            <div className="row gap6" key={i}>
              <input style={{ ...fld, flex: 1.4 }} placeholder="field e.g. metadata.priority" value={c.field || ""} onChange={(e) => setCond(i, "field", e.target.value)} />
              <select style={{ ...fld, flex: 1 }} value={c.cmp || "eq"} onChange={(e) => setCond(i, "cmp", e.target.value)}>
                {CMP_OPS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
              <input style={{ ...fld, flex: 1 }} placeholder="value" value={c.value ?? ""} onChange={(e) => setCond(i, "value", e.target.value)} />
              <button className="btn sm" onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}><I n="ph-x" /></button>
            </div>
          ))}
        </div>
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setConds((c) => [...c, { field: "", cmp: "eq", value: "" }])}><I n="ph-plus" /> Add condition</button>
      </div>

      {/* ACTIONS */}
      <div style={{ ...fld, padding: 14 }}>
        <div className="row gap8" style={{ marginBottom: 10 }}><I n="ph-lightning" style={{ color: "var(--h-automation)" }} /><b>Then (actions)</b></div>
        <div className="col gap8">
          {actions.map((a, i) => (
            <div key={i} style={{ ...fld, background: "var(--surface-1)", padding: 10 }}>
              <div className="row gap6" style={{ marginBottom: 6 }}>
                <span className="mono-sm ghost">{i + 1}</span>
                <select style={{ ...fld, flex: 1 }} value={a.type} onChange={(e) => setActions((as) => as.map((x, j) => j === i ? { type: e.target.value } : x))}>
                  {ACTION_TYPES.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
                <button className="btn sm" onClick={() => moveAct(i, -1)}><I n="ph-arrow-up" /></button>
                <button className="btn sm" onClick={() => moveAct(i, 1)}><I n="ph-arrow-down" /></button>
                <button className="btn sm" onClick={() => setActions((as) => as.filter((_, j) => j !== i))}><I n="ph-trash" /></button>
              </div>
              <ActionParams a={a} i={i} setAct={setAct} otherAutos={otherAutos} />
            </div>
          ))}
        </div>
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setActions((a) => [...a, { type: "notify", message: "" }])}><I n="ph-plus" /> Add action</button>
      </div>

      {err && <div style={{ color: "var(--danger)" }}><I n="ph-warning-circle" /> {err}</div>}
      <div className="row gap8">
        <button className="btn primary" onClick={save}><I n="ph-check" /> Save automation</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ActionParams({ a, i, setAct, otherAutos }: { a: any; i: number; setAct: (i: number, k: string, v: any) => void; otherAutos: { id: string; title: string }[] }) {
  const T = (k: string, ph: string) => <input style={fld} placeholder={ph} value={a[k] ?? ""} onChange={(e) => setAct(i, k, e.target.value)} />;
  switch (a.type) {
    case "createTask": case "createNote": case "createProject":
      return <div>{T("title", "New entity title")}</div>;
    case "notify":
      return <div>{T("message", "Notification message")}</div>;
    case "delay":
      return <div><input style={fld} type="number" placeholder="ms (max 10000)" value={a.ms ?? ""} onChange={(e) => setAct(i, "ms", Number(e.target.value))} /></div>;
    case "archiveEntity": case "deleteEntity":
      return <div>{T("target", "$event.entityId or an item id")}</div>;
    case "updateMetadata":
      return <div className="col gap6">{T("target", "$event.entityId")}<textarea style={{ ...fld, minHeight: 44 }} placeholder='patch JSON e.g. {"archived":true}' value={typeof a.patch === "string" ? a.patch : JSON.stringify(a.patch ?? {})} onChange={(e) => { try { setAct(i, "patch", JSON.parse(e.target.value)); } catch { setAct(i, "patch", e.target.value); } }} /></div>;
    case "createLink": case "deleteLink":
      return <div className="row gap6">{T("source", "source id / $event.entityId")}{T("target", "target id")}{T("rel", "related")}</div>;
    case "triggerAutomation": case "enableAutomation": case "disableAutomation":
      return <select style={fld} value={a.automationId || ""} onChange={(e) => setAct(i, "automationId", e.target.value)}>
        <option value="">select automation…</option>
        {otherAutos.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
      </select>;
    case "stop":
      return <div className="muted">Halts remaining actions.</div>;
    default:
      return null;
  }
}

export function AutomationModule() {
  const { toast } = useLoom();
  const { items, create, updateMeta, updateFields, ready } = useAutomations();
  const { links, items: allItems } = useItemStore();
  const [view, setView] = useState<"list" | "builder" | "history">("list");
  const [editing, setEditing] = useState<{ item: Item; meta: any } | null>(null);
  const [histTarget, setHistTarget] = useState<{ id?: string; title: string } | null>(null);
  const [stats, setStats] = useState<AutomationStats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Read-model: rows (meta + linked + derived chain) + engine-stat cards. The chain
  // summary and the active-rules/runs/success aggregates live in the VM, not render.
  const automationVM = useMemo(
    () => createAutomationViewModel({ items, links, allItems, stats }),
    [items, links, allItems, stats],
  );
  const { rows: list, statCards, options } = automationVM;

  const loadStats = useCallback(() => { getAutomationStats().then(setStats).catch(console.error); }, []);
  useEffect(() => { if (ready) loadStats(); }, [ready, loadStats, items.length]);

  const toggle = async (item: Item) => {
    const meta = getAutomationMeta(item);
    try { await updateMeta(item.id, { ...meta, on: !meta.on }); toast(!meta.on ? "Automation enabled" : "Automation paused", "ph-lightning"); }
    catch (err) { console.error("toggle failed:", err); }
  };

  const runNow = async (item: Item) => {
    setBusy(item.id);
    try { await runAutomationNow(item.id); toast("Ran once — check history", "ph-play"); loadStats(); }
    catch (e: any) { toast("Run failed: " + (e?.message || e), "ph-warning"); }
    finally { setBusy(null); }
  };

  const onSave = async (title: string, meta: any) => {
    if (editing) {
      await updateMeta(editing.item.id, meta);
      if (title !== editing.item.title) await updateFields(editing.item.id, title, "automation");
      toast("Automation updated", "ph-check");
    } else {
      await create(title, meta);
      toast("Automation created", "ph-lightning");
    }
    setView("list"); setEditing(null); loadStats();
  };

  if (view === "builder") {
    return (
      <div className="content-pad fade-in" style={{ "--mod": "var(--h-automation)" } as any}>
        <AutomationBuilder existing={editing} options={options} onCancel={() => { setView("list"); setEditing(null); }} onSave={onSave} />
      </div>
    );
  }
  if (view === "history" && histTarget) {
    return (
      <div className="content-pad fade-in" style={{ "--mod": "var(--h-automation)" } as any}>
        <ExecutionHistory automationId={histTarget.id} title={histTarget.title} onBack={() => { setView("list"); setHistTarget(null); }} />
      </div>
    );
  }

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-automation)" } as any}>
      <PageHead mod="var(--h-automation)" icon="ph-lightning" kicker="Automation" title="Connect the system to itself"
        sub="Event-driven rules executed by the backend engine — real triggers, conditions, actions and run history.">
        <div className="row gap6">
          <button className="btn" onClick={() => { setHistTarget({ title: "All automations" }); setView("history"); }}><I n="ph-clock-counter-clockwise" /> History</button>
          <button className="btn primary" onClick={() => { setEditing(null); setView("builder"); }}><I n="ph-plus" w="bold" /> New rule</button>
        </div>
      </PageHead>

      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(6,1fr)", marginBottom: 22 }}>
        {statCards.map((card, i) => (
          <div className="stat" key={i} style={{ "--mod": card.color } as any}>
            <div className="row" style={{ justifyContent: "space-between" }}><div className="v">{card.value}</div><I n={card.icon} w="fill" style={{ color: card.color, fontSize: "var(--fs-xl)" }} /></div>
            <div className="l">{card.label}</div>
          </div>
        ))}
      </div>

      {!ready ? (
        <div className="muted" style={{ padding: "20px 0" }}>Loading automations...</div>
      ) : list.length === 0 ? (
        <EmptyState icon="ph-lightning" mod="var(--h-automation)" title="No automations yet" sub="Build a trigger → condition → action rule to automate a flow." />
      ) : (
        <div className="col gap16">
          {list.map(({ item, meta, linked, chain }) => (
              <div key={item.id} className="flow-card" style={{ "--mod": meta.color, opacity: meta.on ? 1 : 0.62 } as any}>
                <div className="flow-head">
                  <div className="w-ico" style={{ "--mod": meta.color, width: 30, height: 30, fontSize: "var(--fs-xl)" } as any}><I n="ph-lightning" w="fill" /></div>
                  <div style={{ flex: 1 }}>
                    <div className="row gap8">
                      <span style={{ fontWeight: 600, fontSize: "var(--fs-base)" }}>{item.title}</span>
                      {meta.on && <span className="mono-sm" style={{ color: meta.color }}>● live</span>}
                      {!meta.trigger && <span className="chip" style={{ height: 20 }}><I n="ph-warning" /> not executable</span>}
                    </div>
                    <div className="muted" style={{ fontSize: "var(--fs-sm)", marginTop: 2 }}>{meta.desc}</div>
                  </div>
                  <span className="mono-sm ghost">{meta.runs} runs</span>
                  <Switch.Root className="rx-switch" checked={meta.on} onCheckedChange={() => toggle(item)} aria-label={`${item.title} ${meta.on ? "on" : "off"}`}>
                    <Switch.Thumb className="rx-switch-thumb" />
                  </Switch.Root>
                </div>
                <div className="flow-chain">
                  {chain.map((node, i) => (
                    <React.Fragment key={i}>
                      <div className="flow-node"><I n={node.i} /><div><div className="fn-l">{node.l}</div><div className="fn-t">{node.t}</div></div></div>
                      {i < chain.length - 1 && <div className="flow-arrow"><I n="ph-arrow-right" w="bold" /></div>}
                    </React.Fragment>
                  ))}
                </div>
                {linked.length > 0 && (
                  <div className="row wrap gap6" style={{ marginTop: 12 }}>{linked.map((x) => <EntityChip key={x.id} id={x.id} />)}</div>
                )}
                <div className="row gap6" style={{ marginTop: 12 }}>
                  <button className="btn sm" disabled={busy === item.id} onClick={() => runNow(item)}>
                    <I n={busy === item.id ? "ph-spinner" : "ph-play"} /> Run now
                  </button>
                  <button className="btn sm" onClick={() => { setHistTarget({ id: item.id, title: item.title }); setView("history"); }}><I n="ph-clock-counter-clockwise" /> History</button>
                  <button className="btn sm" onClick={() => { setEditing({ item, meta }); setView("builder"); }}><I n="ph-pencil-simple" /> Edit</button>
                  {meta.lastRun && <span className="mono-sm ghost" style={{ marginLeft: "auto", alignSelf: "center" }}>last run {new Date(meta.lastRun).toLocaleString()}</span>}
                </div>
              </div>
          ))}
        </div>
      )}

      {/* Local API & Webhooks — still genuinely not implemented; kept honestly disabled. */}
      <div className="api-webhooks-section" style={{ marginTop: 40, padding: 20, background: "var(--surface-2)", borderRadius: "var(--r-md)", border: "1px solid var(--border)", opacity: 0.7 }}>
        <div className="row gap12" style={{ marginBottom: 12 }}>
          <I n="ph-plugs" style={{ fontSize: 24, color: "var(--text-faint)" }} />
          <h3 style={{ fontSize: "var(--fs-lg)", fontWeight: 600 }}>Local API & Webhooks</h3>
          <span className="chip" style={{ height: 22 }}><I n="ph-flask" /> Experimental — not yet available</span>
        </div>
        <p className="muted" style={{ marginBottom: 16 }}>A local REST/WebSocket API for external integrations is planned but not implemented yet.</p>
        <div className="row gap12">
          <button className="btn sm" disabled title="Not yet available"><I n="ph-key" /> Generate API Key</button>
          <button className="btn sm" disabled title="Not yet available"><I n="ph-globe" /> Create Webhook</button>
        </div>
      </div>
    </div>
  );
}
