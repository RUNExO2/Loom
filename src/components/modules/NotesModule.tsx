import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { listStagger, listItem } from "../../lib/motionVariants";
import { I, cx, useLoom, clickable } from "../../lib/context";
import { EntityChip, EmptyState } from "../shared";
import { NoteEditor, NoteEditorApi } from "../NoteEditor";
import { MediaTools } from "../MediaTools";
import { Item } from "../../ipc/items";
import { useNotes, useFiles, useItemStore } from "../../lib/itemStore";
import { useViewMemory } from "../../lib/viewMemory";
import { getNoteMeta } from "../../lib/meta";
import { createNotesViewModel, createGraphViewModel } from "../../lib/viewmodels";
import { deleteCommand, useCommands } from "../../lib/commands";
import { useModal } from "../Modal";
import { convertFileSrc } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { save, open } from "@tauri-apps/plugin-dialog";
import { fsWriteAnyFile, fsCopyFile, fsOpenFile } from "../../ipc/fs";
import { PageHeadCompact } from "./shared";

interface FGNode { id: string; title: string; item_type: string; x: number; y: number; vx: number; vy: number; }
interface FGEdge { source: string; target: string; }
interface GraphPhysics { repulsion: number; attraction: number; gravity: number; }

function readGraphColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string, fb: string) => (cs.getPropertyValue(k).trim() || fb);
  return {
    edge: v("--graph-edge", v("--border-strong", "rgba(120,120,120,0.4)")),
    edgeHi: v("--graph-edge-active", v("--accent", "#6366f1")),
    label: v("--graph-label", v("--text", "#1c1c1c")),
    halo: v("--surface-1", "#ffffff"),
    muted: v("--text-faint", "#8a8a8a"),
    types: {
      note: v("--h-notes", "#a78bfa"), task: v("--h-tasks", "#f97316"),
      project: v("--h-projects", "#22c55e"), habit: v("--h-habits", "#ec4899"),
      calendar: v("--h-calendar", "#3b82f6"), bookmark: v("--h-bookmarks", "#eab308"),
      library: v("--h-library", "#f43f5e"), file: v("--h-files", "#64748b"),
      vault: v("--h-vault", "#14b8a6"), automation: v("--h-automation", "#8b5cf6"),
    } as Record<string, string>,
  };
}

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
  const wrapRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<FGNode[]>([]);
  const rafRef = useRef<number>(0);
  const tickRef = useRef(0);
  const MAX_TICKS = 600;
  const NODE_R = 18;
  const panRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const sizeRef = useRef({ w: 800, h: 600, dpr: 1 });
  const hoverRef = useRef<string | null>(null);
  const dirtyRef = useRef(true);
  const dragging = useRef<{ nodeId: string | null; mx: number; my: number; startX: number; startY: number; moved: boolean }>({ nodeId: null, mx: 0, my: 0, startX: 0, startY: 0, moved: false });
  const panning = useRef<{ active: boolean; sx: number; sy: number; px: number; py: number }>({ active: false, sx: 0, sy: 0, px: 0, py: 0 });

  const fitView = useCallback(() => {
    const ns = nodesRef.current;
    const { w, h } = sizeRef.current;
    if (ns.length === 0) { panRef.current = { x: w / 2, y: h / 2 }; scaleRef.current = 1; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
    const pad = 90;
    const gw = (maxX - minX) || 1, gh = (maxY - minY) || 1;
    const s = Math.max(0.2, Math.min((w - pad * 2) / gw, (h - pad * 2) / gh, 1.4));
    scaleRef.current = s;
    panRef.current = { x: w / 2 - ((minX + maxX) / 2) * s, y: h / 2 - ((minY + maxY) / 2) * s };
    dirtyRef.current = true;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let colors = readGraphColors();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = wrap.clientWidth || 800;
      const h = wrap.clientHeight || 600;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      dirtyRef.current = true;
    };
    resize();

    tickRef.current = 0;
    const spread = Math.max(180, nodes.length * 11);
    nodesRef.current = nodes.map((n, i) => {
      const angle = (i / Math.max(nodes.length, 1)) * 2 * Math.PI;
      return { ...n, x: Math.cos(angle) * spread, y: Math.sin(angle) * spread, vx: 0, vy: 0 };
    });
    fitView();

    const edgeMap = new Map<string, Set<string>>();
    edges.forEach(e => {
      if (!edgeMap.has(e.source)) edgeMap.set(e.source, new Set());
      if (!edgeMap.has(e.target)) edgeMap.set(e.target, new Set());
      edgeMap.get(e.source)!.add(e.target);
      edgeMap.get(e.target)!.add(e.source);
    });
    const nodeIndex = new Map<string, FGNode>();

    const physicsStep = () => {
      const ns = nodesRef.current;
      nodeIndex.clear();
      for (const n of ns) nodeIndex.set(n.id, n);
      const rep = physics.repulsion, att = physics.attraction, grav = physics.gravity;
      const damping = 0.85;
      for (let i = 0; i < ns.length; i++) {
        if (dragging.current.nodeId === ns[i].id) continue;
        let fx = -ns[i].x * grav, fy = -ns[i].y * grav;
        for (let j = 0; j < ns.length; j++) {
          if (i === j) continue;
          const dx = ns[i].x - ns[j].x, dy = ns[i].y - ns[j].y;
          const d2 = dx * dx + dy * dy + 1;
          const d = Math.sqrt(d2);
          fx += (dx / d) * rep / d2 * 1000;
          fy += (dy / d) * rep / d2 * 1000;
        }
        const neighbors = edgeMap.get(ns[i].id);
        if (neighbors) neighbors.forEach(tid => {
          const t = nodeIndex.get(tid);
          if (!t) return;
          const dx = t.x - ns[i].x, dy = t.y - ns[i].y;
          const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
          const stretch = d - 110;
          fx += dx / d * stretch * att * 0.5;
          fy += dy / d * stretch * att * 0.5;
        });
        ns[i].vx = (ns[i].vx + fx) * damping;
        ns[i].vy = (ns[i].vy + fy) * damping;
        ns[i].x += ns[i].vx;
        ns[i].y += ns[i].vy;
      }
    };

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { w, h, dpr } = sizeRef.current;
      const scale = scaleRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(panRef.current.x, panRef.current.y);
      ctx.scale(scale, scale);

      const hovered = hoverRef.current;
      const hl = hovered ? (edgeMap.get(hovered) || new Set<string>()) : null;

      edges.forEach(e => {
        const s = nodeIndex.get(e.source) || nodesRef.current.find(n => n.id === e.source);
        const t = nodeIndex.get(e.target) || nodesRef.current.find(n => n.id === e.target);
        if (!s || !t) return;
        const active = hovered && (e.source === hovered || e.target === hovered);
        ctx.strokeStyle = active ? colors.edgeHi : colors.edge;
        ctx.lineWidth = (active ? 2 : 1.1) / scale;
        ctx.globalAlpha = hovered && !active ? 0.35 : 1;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();
      });
      ctx.globalAlpha = 1;

      const showLabels = scale > 0.55;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      nodesRef.current.forEach(n => {
        const color = colors.types[n.item_type] || colors.muted;
        const isHover = n.id === hovered;
        const isNeighbor = hl?.has(n.id);
        const r = isHover ? NODE_R + 3 : NODE_R;
        const dim = hovered && !isHover && !isNeighbor;
        ctx.globalAlpha = dim ? 0.4 : 1;

        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = color + (isHover ? "55" : "33");
        ctx.fill();
        ctx.lineWidth = (isHover ? 2.5 : 1.6) / scale;
        ctx.strokeStyle = color;
        ctx.stroke();

        if (showLabels || isHover || isNeighbor) {
          const label = n.title.length > 18 ? n.title.slice(0, 17) + "…" : n.title;
          ctx.font = `${isHover ? 600 : 400} 12px ui-sans-serif, system-ui, sans-serif`;
          ctx.lineWidth = 3 / scale;
          ctx.strokeStyle = colors.halo;
          ctx.lineJoin = "round";
          ctx.strokeText(label, n.x, n.y + r + 11);
          ctx.fillStyle = colors.label;
          ctx.fillText(label, n.x, n.y + r + 11);
        }
        ctx.globalAlpha = 1;
      });
    };

    let alive = true;
    const loop = () => {
      if (!alive) return;
      if (tickRef.current < MAX_TICKS) {
        physicsStep();
        tickRef.current++;
        dirtyRef.current = true;
        if (tickRef.current < 160 && tickRef.current % 40 === 0) fitView();
      }
      if (dirtyRef.current) { draw(); dirtyRef.current = false; }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    const ro = new ResizeObserver(() => { resize(); fitView(); });
    ro.observe(wrap);
    const mo = new MutationObserver(() => { colors = readGraphColors(); dirtyRef.current = true; });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });

    return () => { alive = false; cancelAnimationFrame(rafRef.current); ro.disconnect(); mo.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, physics.repulsion, physics.attraction, physics.gravity, fitView]);

  const worldPos = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - panRef.current.x) / scaleRef.current,
      y: (clientY - rect.top - panRef.current.y) / scaleRef.current,
    };
  }, []);

  const hitTest = useCallback((wx: number, wy: number) => {
    const ns = nodesRef.current;
    for (let i = ns.length - 1; i >= 0; i--) {
      const dx = ns[i].x - wx, dy = ns[i].y - wy;
      if (dx * dx + dy * dy < (NODE_R + 4) * (NODE_R + 4)) return ns[i];
    }
    return null;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) return;
    const { x, y } = worldPos(e.clientX, e.clientY);
    const hit = hitTest(x, y);
    if (hit) {
      dragging.current = { nodeId: hit.id, mx: x - hit.x, my: y - hit.y, startX: e.clientX, startY: e.clientY, moved: false };
    } else {
      panning.current = { active: true, sx: e.clientX, sy: e.clientY, px: panRef.current.x, py: panRef.current.y };
    }
  }, [worldPos, hitTest]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging.current.nodeId) {
      const { x, y } = worldPos(e.clientX, e.clientY);
      const node = nodesRef.current.find(n => n.id === dragging.current.nodeId);
      if (node) { node.x = x - dragging.current.mx; node.y = y - dragging.current.my; node.vx = 0; node.vy = 0; }
      dragging.current.moved = true;
      if (tickRef.current >= MAX_TICKS) tickRef.current = MAX_TICKS - 80;
      dirtyRef.current = true;
    } else if (panning.current.active) {
      panRef.current.x = panning.current.px + (e.clientX - panning.current.sx);
      panRef.current.y = panning.current.py + (e.clientY - panning.current.sy);
      dirtyRef.current = true;
    } else {
      const { x, y } = worldPos(e.clientX, e.clientY);
      const hit = hitTest(x, y);
      const id = hit ? hit.id : null;
      if (id !== hoverRef.current) { hoverRef.current = id; dirtyRef.current = true; }
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = hit ? "pointer" : "grab";
    }
  }, [worldPos, hitTest]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (dragging.current.nodeId) {
      const node = dragging.current.nodeId;
      const moved = Math.hypot(e.clientX - dragging.current.startX, e.clientY - dragging.current.startY) >= 5;
      dragging.current = { nodeId: null, mx: 0, my: 0, startX: 0, startY: 0, moved: false };
      if (!moved) onNodeClick(node);
    } else if (panning.current.active) {
      const moved = Math.hypot(e.clientX - panning.current.sx, e.clientY - panning.current.sy) >= 5;
      panning.current.active = false;
      if (!moved) {
        const { x, y } = worldPos(e.clientX, e.clientY);
        const hit = hitTest(x, y);
        if (hit) onNodeClick(hit.id);
      }
    }
  }, [worldPos, hitTest, onNodeClick]);

  const handleMouseLeave = useCallback(() => {
    panning.current.active = false;
    dragging.current.nodeId = null;
    if (hoverRef.current) { hoverRef.current = null; dirtyRef.current = true; }
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const wx = (mx - panRef.current.x) / scaleRef.current;
    const wy = (my - panRef.current.y) / scaleRef.current;
    const next = Math.max(0.15, Math.min(5, scaleRef.current * (e.deltaY > 0 ? 0.9 : 1.1)));
    scaleRef.current = next;
    panRef.current = { x: mx - wx * next, y: my - wy * next };
    dirtyRef.current = true;
  }, []);

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        style={{ display: "block", cursor: "grab", touchAction: "none" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
      />
    </div>
  );
}

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
  const { importFile } = useFiles();
  const { links, items: allItems, workspaceId } = useItemStore();
  const loading = !ready;

  const [activeId, setActiveId] = useViewMemory<string | null>("notes.active", focusId || null);
  const [q, setQ] = useViewMemory("notes.query", "");
  const [folderFilter, setFolderFilter] = useViewMemory("notes.folder", "all");
  const [contentHtml, setContentHtml] = useState<string>("");
  const [isEditing, setIsEditing] = useState<boolean>(false);

  const [isSummarizing, setIsSummarizing] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [find, setFind] = useState<{ open: boolean; q: string }>({ open: false, q: "" });
  const findInputRef = useRef<HTMLInputElement>(null);

  const [showGraph, setShowGraph] = useState(false);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showPhysicsPanel, setShowPhysicsPanel] = useState(false);
  const [graphTypeFilter, setGraphTypeFilter] = useState<Set<string>>(new Set(["all"]));
  const [graphPhysics, setGraphPhysics] = useState<GraphPhysics>({ repulsion: 200, attraction: 0.1, gravity: 0.05 });

  useEffect(() => {
    if (!(window as any).mermaid) {
      import("mermaid").then((m) => {
        const mermaid = m.default;
        mermaid.initialize({ startOnLoad: false, theme: "dark" });
        (window as any).mermaid = mermaid;
      }).catch((e) => console.error("Mermaid load failed:", e));
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && activeId) {
        e.preventDefault();
        setFind((f) => ({ ...f, open: true }));
        setTimeout(() => findInputRef.current?.select(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId]);

  // ponytail: native window.find — works in the Chromium WebView. Seeds the caret at
  // the note body so the first match is in the note, not the sidebar. Upgrade path:
  // CSS Custom Highlight API for in-place highlight-all if a count/next-prev is wanted.
  const runFind = (query: string, backwards = false) => {
    if (!query) return;
    const body = document.querySelector(".note-editor-body");
    if (body && !backwards) {
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(body, 0); r.collapse(true);
      sel?.removeAllRanges(); sel?.addRange(r);
    }
    (window as any).find?.(query, false, backwards, true);
  };

  const togglePin = async (e: React.MouseEvent, note: Item) => {
    e.stopPropagation();
    const meta = getNoteMeta(note);
    try { await updateMeta(note.id, { ...meta, pinned: !(meta as any).pinned }); toast((meta as any).pinned ? "Unpinned" : "Pinned to top", "ph-push-pin"); }
    catch (err) { console.error("Failed to pin note:", err); }
  };

  const editorApiRef = useRef<NoteEditorApi | null>(null);
  const autosaveTimer = useRef<any>(null);
  const lastSavedHtml = useRef<string | null>(null);

  useEffect(() => {
    if (!activeId && notes.length > 0) setActiveId(notes[0].id);
  }, [notes, activeId]);

  useEffect(() => {
    if (focusId) {
      const note = notes.find((n) => n.id === focusId);
      if (note) setActiveId(focusId);
    }
  }, [focusId, notes]);

  const notesVM = useMemo(
    () => createNotesViewModel({ notes, links, allItems, folderFilter, query: q, activeId }),
    [notes, links, allItems, folderFilter, q, activeId],
  );
  const { activeNote, activeMeta: activeNoteMeta, activeLinks: activeNoteLinks } = notesVM;

  const graphVM = useMemo(
    () => createGraphViewModel({ items: allItems, links }, graphTypeFilter),
    [allItems, links, graphTypeFilter]
  );

  useEffect(() => {
    if (activeNoteMeta?.path) {
      readNoteContent(activeNoteMeta.path)
        .then((html) => {
          setContentHtml(html);
          lastSavedHtml.current = html;
          setAiSummary(null);
          setIsEditing(false);
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
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, []);

  const saveContent = async (html: string) => {
    if (!activeNote || !activeNoteMeta?.path) return;
    if (html === lastSavedHtml.current) return;
    try {
      await writeNoteContent(activeNote.id, html);
      lastSavedHtml.current = html;
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = html;
      const plainText = tempDiv.innerText || tempDiv.textContent || "";
      const words = plainText.trim().split(/\s+/).filter(Boolean).length;
      const preview = plainText.trim().slice(0, 140);
      const currentVersions = (activeNoteMeta as any).versions || [];
      const newVersions = [{ date: new Date().toISOString(), preview: preview.slice(0, 50) + "..." }, ...currentVersions].slice(0, 5);
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

  const handleInput = (html: string) => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => { saveContent(html); }, 1500);
  };

  const handleEditorSave = (html: string) => {
    setContentHtml(html);
    saveContent(html).then(() => {
      setIsEditing(false);
      toast("Note saved to disk", "ph-check-circle");
    });
  };

  const handleEditorDiscard = () => {
    if (activeNoteMeta?.path) {
      readNoteContent(activeNoteMeta.path).then((html) => {
        setContentHtml(html);
        setIsEditing(false);
        toast("Edits discarded", "ph-x-circle");
      });
    } else {
      setIsEditing(false);
    }
  };

  const handleAISummarize = async () => {
    if (!activeNote) return;
    setIsSummarizing(true);
    try {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = editorApiRef.current?.getHTML() || contentHtml;
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
    const r = await modal.form({ panel: true,
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
    const r = await modal.form({ panel: true,
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
    const ok = await modal.confirm({ title: "Delete note", message: `Delete "${activeNote.title}"? This will remove the file from your disk.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
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
    const fmt = await modal.form({ panel: true,
      title: "Export note", icon: "ph-export", accent: "var(--h-notes)", submitLabel: "Choose location…",
      fields: [{
        name: "format", label: "Format", type: "select", defaultValue: "md",
        options: [
          { value: "md", label: "Markdown (.md)" },
          { value: "html", label: "HTML (.html)" },
          { value: "txt", label: "Plain text (.txt)" },
        ],
      }],
    });
    if (!fmt) return;
    const ext = fmt.format as string;
    const dest = await save({
      title: "Export Note",
      defaultPath: `${activeNote.title}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!dest) return;
    try {
      if (ext === "html") {
        await fsCopyFile(activeNoteMeta.path, dest);
      } else if (ext === "md") {
        await fsWriteAnyFile(dest, htmlToMarkdown(contentHtml));
      } else {
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = contentHtml;
        await fsWriteAnyFile(dest, tempDiv.innerText || tempDiv.textContent || "");
      }
      toast(`Note exported as ${ext.toUpperCase()}`, "ph-export");
    } catch (err: any) {
      modal.confirm({ title: "Export Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleAttachFile = async () => {
    const selected = await open({ multiple: false, title: "Select File to Attach" });
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
      editorApiRef.current?.insertHTML(attachmentHtml);
      toast("File attached to note", "ph-paperclip");
    } catch (err: any) {
      modal.confirm({ title: "Error", message: String(err), icon: "ph-warning", danger: true });
    }
  };

  const handleAutoTag = async () => {
    if (!activeNote || !activeNoteMeta) return;
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = editorApiRef.current?.getHTML() || contentHtml;
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
          if (isEditing && editorApiRef.current) {
            editorApiRef.current.insertHTML(attachmentHtml);
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
                <button className="btn sm" onClick={handleRenameNote} title="Rename note"><I n="ph-pencil" /> Rename</button>
                <button className="btn sm" onClick={handleOpenFolder} title="Open Containing Folder"><I n="ph-folder-open" /> Reveal</button>
                <button className="btn sm" onClick={handlePopout} title="Open in New Window"><I n="ph-app-window" /> Pop-out</button>
                <button className="btn sm" onClick={handleSaveAs} title="Save Copy As..."><I n="ph-floppy-disk" /> Save As</button>
                <button className="btn sm" onClick={handleExportNote} title="Export Note..."><I n="ph-export" /> Export</button>
                <button className={`btn sm ${isEditing ? "active" : ""}`} onClick={() => {
                  if (isEditing && editorApiRef.current) {
                    setContentHtml(editorApiRef.current.getHTML());
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

                {find.open && (
                  <div className="row gap6" style={{ position: "sticky", top: 8, zIndex: 20, marginBottom: 8, padding: 6, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", boxShadow: "var(--shadow-md)", width: "fit-content" }}>
                    <I n="ph-magnifying-glass" />
                    <input
                      ref={findInputRef}
                      placeholder="Find in note…"
                      value={find.q}
                      onChange={(e) => setFind((f) => ({ ...f, q: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); runFind(find.q, e.shiftKey); }
                        else if (e.key === "Escape") { e.preventDefault(); setFind({ open: false, q: "" }); }
                      }}
                      style={{ background: "transparent", border: "none", outline: "none", color: "var(--text)", width: 200 }}
                      autoFocus
                    />
                    <button className="btn icon sm" title="Previous (Shift+Enter)" onClick={() => runFind(find.q, true)}><I n="ph-arrow-up" /></button>
                    <button className="btn icon sm" title="Next (Enter)" onClick={() => runFind(find.q, false)}><I n="ph-arrow-down" /></button>
                    <button className="btn icon sm" title="Close (Esc)" onClick={() => setFind({ open: false, q: "" })}><I n="ph-x" /></button>
                  </div>
                )}

                {isEditing ? (
              <>
                {aiSummary && (
                  <div style={{ padding: "12px 16px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", display: "flex", gap: 12, marginTop: 14 }}>
                    <I n="ph-magic-wand" style={{ color: "var(--accent)", fontSize: 20, marginTop: 2 }} />
                    <div style={{ flex: 1, fontSize: "var(--fs-sm)", lineHeight: 1.5 }}>
                      <b style={{ color: "var(--text)" }}>AI Summary</b>
                      <div className="muted">{aiSummary}</div>
                    </div>
                    <button className="btn icon sm" onClick={() => setAiSummary(null)}><I n="ph-x" /></button>
                  </div>
                )}
                <NoteEditor
                  key={activeNote.id}
                  apiRef={editorApiRef}
                  initialHtml={contentHtml}
                  onChange={handleInput}
                  onSave={handleEditorSave}
                  onDiscard={handleEditorDiscard}
                  onAttach={handleAttachFile}
                  onSummarize={handleAISummarize}
                  onAutoTag={handleAutoTag}
                  summarizing={isSummarizing}
                  extraTools={(editor) => (
                    <MediaTools
                      editor={editor}
                      importFile={importFile}
                      toast={toast}
                      confirmCopy={(filename) => modal.confirm({
                        title: "Embed Strategy",
                        message: `Embed: ${filename}\n\nCopy file into Loom or keep it where it is?`,
                        icon: "ph-monitor-play",
                        confirmLabel: "Copy to Loom",
                        cancelLabel: "Keep Reference",
                      })}
                    />
                  )}
                />
              </>
            ) : (
              <div
                className="note-editor-body"
                style={{ padding: "20px 0", cursor: "pointer" }}
                onDoubleClick={() => setIsEditing(true)}
                onClick={handleDocClick}
                dangerouslySetInnerHTML={{ __html: contentHtml || "<p class='note-empty-hint'>This note is empty. Double-click anywhere to start writing.</p>" }}
              />
            )}

            <div className="divider"></div>
            <h2 style={{ marginTop: 0 }}>Linked</h2>
            <div className="row wrap gap8">{activeNoteLinks.map((it) => <EntityChip key={it.id} id={it.id} sub />)}</div>
          </div>

        </div>
        </div>
        ) : (
          <div className="doc-pad fade-in">
             <EmptyState icon="ph-note" mod="var(--h-notes)" title="No note selected" sub="Pick a note from the list to read it here." />
          </div>
        )}
      </div>
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
