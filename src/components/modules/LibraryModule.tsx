import React, { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { listStagger, listItem } from "../../lib/motionVariants";
import { I, cx, useLoom, clickable } from "../../lib/context";
import { EmptyState } from "../shared";
import { Item } from "../../ipc/items";
import { useLibrary, useFiles, useItemStore } from "../../lib/itemStore";
import { useViewMemory } from "../../lib/viewMemory";
import { getLibraryMeta } from "../../lib/meta";
import { createLibraryViewModel } from "../../lib/viewmodels";
import { deleteCommand, useCommands } from "../../lib/commands";
import { useModal } from "../Modal";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { PageHead } from "./shared";

const UNIT_FOR: Record<string, [string, string]> = {
  anime: ["Episode", "ep"], tv: ["Episode", "ep"],
  manga: ["Chapter", "ch"], manhwa: ["Chapter", "ch"], manhua: ["Chapter", "ch"],
  book: ["Page", "pp"], game: ["Hour", "h"],
};

const isCountProgress = (type: string) => type !== "movie";

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

function CoverOption({ c, onPick }: { c: { url: string; title: string }; onPick: () => void }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <div className="cover-option" style={{ display: "flex", alignItems: "center", justifyContent: "center", aspectRatio: "2/3", background: "var(--surface-2)", color: "var(--text-faint)", cursor: "default" }} title={`${c.title} (image unavailable)`}>
        <I n="ph-image-broken" style={{ fontSize: 26 }} />
      </div>
    );
  }
  return (
    <button className="cover-option" onClick={onPick} title={c.title}>
      <img src={c.url} loading="lazy" alt={c.title} onError={() => setErr(true)} />
      <span>{c.title}</span>
    </button>
  );
}

export function LibraryModule() {
  const { inspect, toast, dragTargetId, setDragTargetId } = useLoom();
  const modal = useModal();
  const commands = useCommands();
  const { items, create, updateMeta, updateFields, remove, restore, ready } = useLibrary();
  const { importFile } = useFiles();
  const { links } = useItemStore();
  const loading = !ready;

  const [cat, setCat] = useViewMemory("library.cat", "all");
  const cats: [string, string][] = [
    ["all", "All"], ["anime", "Anime"], ["manga", "Manga"], ["manhwa", "Manhwa"],
    ["manhua", "Manhua"], ["book", "Books"], ["movie", "Movies"], ["tv", "TV Shows"], ["game", "Games"]
  ];

  const [coverPicker, setCoverPicker] = useState<{ itemId: string, query: string, mediaType: string, candidates: any[], page: number, loading: boolean } | null>(null);

  const openCoverPicker = async (itemId: string, query: string, mediaType: string, page: number) => {
    setCoverPicker((prev) => ({ itemId, query, mediaType, candidates: prev?.itemId === itemId ? prev.candidates : [], page, loading: true }));
    try {
      const candidates: any[] = await invoke("fetch_cover_candidates", { query, mediaType, page });
      if ((!candidates || candidates.length === 0) && page > 1) {
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
    const r1 = await modal.form({ panel: true,
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
    const counts = isCountProgress(type);
    const [unitLabel] = UNIT_FOR[type] || ["Progress", ""];
    const unit = unitLabel.toLowerCase();
    const r2 = await modal.form({ panel: true,
      title: "Add Media (Step 2 of 2)", icon: "ph-stack", accent: "var(--h-library)", submitLabel: "Next — Pick a Cover",
      fields: [
        { name: "status", label: "Status", type: "select", defaultValue: statusOptions[0].value, options: statusOptions },
        ...(counts ? [
          { name: "current", label: `Current ${unit}`, defaultValue: "0", type: "text" as const, placeholder: "0" },
          { name: "total", label: `Total ${unit}s (0 if unknown)`, defaultValue: "0", type: "text" as const, placeholder: "0" },
        ] : []),
        { name: "favorite", label: "Favorite", type: "select", defaultValue: "no", options: [{ value: "no", label: "No" }, { value: "yes", label: "⭐ Yes" }] }
      ]
    });
    if (!r2) return;

    const total = counts ? Math.max(0, parseInt(r2.total, 10) || 0) : 1;
    const currentRaw = counts ? Math.max(0, parseInt(r2.current, 10) || 0) : (r2.status === "Watched" || r2.status === "Completed" ? 1 : 0);
    const current = total > 0 ? Math.min(currentRaw, total) : currentRaw;
    let status = r2.status;
    if (counts && total > 0 && current >= total) status = "Completed";
    const completed = status === "Completed" || status === "Watched";
    const now = new Date().toISOString();

    try {
      const ICON_FOR: Record<string, string> = { game: "ph-game-controller", anime: "ph-television", manga: "ph-book", book: "ph-book-open", manhwa: "ph-book", manhua: "ph-book", movie: "ph-film-strip", tv: "ph-television" };
      const createdItem = await create(title, {
        mediaType: type, status, favorite: r2.favorite === "yes", coverPath: "", notes: "", tags: [],
        progress: { current, total },
        tracking: completed ? { lastActivityAt: now, finishedAt: now } : (current > 0 ? { lastActivityAt: now } : {}),
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

  const handleUploadCover = async () => {
    if (!coverPicker) return;
    const selected = await open({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp"] }] });
    if (!selected || typeof selected !== "string") return;
    const item = items.find((it) => it.id === coverPicker.itemId);
    if (!item) return;
    try {
      const imported = await importFile(selected, "copy");
      const meta = getLibraryMeta(item);
      await updateMeta(item.id, { ...meta, coverPath: imported.path });
      toast(`Set cover for ${item.title}`, "ph-image");
      setCoverPicker(null);
    } catch (err) {
      console.error("Cover upload failed:", err);
      toast("Couldn't import that image.", "ph-warning");
    }
  };

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
    const ok = await modal.confirm({ title: "Delete item", message: `Delete "${item.title}"? You can undo right after.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
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
    const r = await modal.form({ panel: true,
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
    const r = await modal.form({ panel: true,
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
      const tags = r.tag.split(",").map((t: string) => t.trim()).filter(Boolean);
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

  const libraryVM = useMemo(() => createLibraryViewModel({ items, cat }), [items, cat]);

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-library)" } as any}>
      <PageHead mod="var(--h-library)" icon="ph-stack" kicker="Library" title="Media tracking"
        sub="Books, anime, manga, movies, tv, and games — tracked accurately.">
        <div className="seg" style={{ flexWrap: "wrap", marginBottom: 8 }}>{cats.map(([k, l]) => <button key={k} className={cx(cat === k && "on")} onClick={() => setCat(k)}>{l}</button>)}</div>
        <button className="btn primary" onClick={handleNewItem}><I n="ph-plus" w="bold" /> Add Media</button>
      </PageHead>

      {coverPicker && (
        <Dialog.Root open onOpenChange={(o) => { if (!o) setCoverPicker(null); }}>
          <Dialog.Portal>
            <Dialog.Overlay asChild>
              <div className="cover-picker-scrim">
                <Dialog.Content asChild aria-describedby={undefined}>
                  <div className="cover-picker" onClick={(e) => e.stopPropagation()}>
                    <div className="cover-picker-head">
                      <div className="modal-ico" style={{ "--mod": "var(--h-library)" } as any}><I n="ph-image" w="fill" /></div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Dialog.Title asChild>
                          <div style={{ fontWeight: 600, fontSize: "var(--fs-base)" }}>Pick a cover for "{coverPicker.query}"</div>
                        </Dialog.Title>
                        <div className="ghost mono-sm" style={{ fontSize: "var(--fs-2xs)" }}>Set {coverPicker.page} · saved locally to your Covers folder</div>
                      </div>
                      <button className="btn sm" onClick={handleUploadCover} title="Use an image from your computer">
                        <I n="ph-upload-simple" /> Upload
                      </button>
                      <button className="btn sm" onClick={() => openCoverPicker(coverPicker.itemId, coverPicker.query, coverPicker.mediaType, coverPicker.page + 1)} disabled={coverPicker.loading} title="Fetch a different set of covers">
                        <I n="ph-arrows-clockwise" /> Refresh
                      </button>
                      <Dialog.Close asChild>
                        <button className="btn icon sm" title="Skip — keep default cover" aria-label="Close cover picker"><I n="ph-x" /></button>
                      </Dialog.Close>
                    </div>
                    <div className="cover-picker-grid">
                      {coverPicker.loading
                        ? Array.from({ length: 10 }).map((_, i) => <div key={i} className="skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--r-md)" }} />)
                        : coverPicker.candidates.map((c, i) => (
                          <CoverOption key={i} c={c} onPick={() => handlePickCover(c.url)} />
                        ))}
                      {!coverPicker.loading && coverPicker.candidates.length === 0 && (
                        <div className="muted" style={{ gridColumn: "1 / -1", textAlign: "center", padding: 30 }}>No covers found. Try Refresh or close to keep the default.</div>
                      )}
                    </div>
                  </div>
                </Dialog.Content>
              </div>
            </Dialog.Overlay>
          </Dialog.Portal>
        </Dialog.Root>
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
