import React, { useState, useEffect, useMemo } from "react";
import { I, cx, useLoom, clickable } from "../../lib/context";
import { Item } from "../../ipc/items";
import { useBookmarks, useItemStore, useNotes } from "../../lib/itemStore";
import { getBookmarkMeta } from "../../lib/meta";
import { createBookmarksViewModel } from "../../lib/viewmodels";
import { useModal } from "../Modal";
import { EmptyState } from "../shared";
import { fsReadNoteContent } from "../../ipc/fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TYPE_ICON, TYPE_LABEL } from "../../lib/typeMeta";
import { ReaderView } from "../ReaderView";
import { fetchReadableArticle, ReadableArticle } from "../../ipc/content";
import { PageHead } from "./shared";

export function BookmarksModule() {
  const { inspect, toast } = useLoom();
  const modal = useModal();
  const { items, create, updateMeta, updateFields, remove, ready } = useBookmarks();
  const { resolve, workspaceId, refresh } = useItemStore();
  const notes = useNotes();
  const loading = !ready;
  const [kind, setKind] = useState<"all" | "web" | "app">("all");
  const [readerUrl, setReaderUrl] = useState<string | null>(null);
  const { cards } = useMemo(() => createBookmarksViewModel({ bookmarks: items, resolve }, { kind }), [items, resolve, kind]);

  const clipArticle = async (article: ReadableArticle) => {
    if (!workspaceId) return;
    try {
      const note = await notes.create(article.title || "Clipped article");
      const header = `<h1>${article.title}</h1>` +
        `<p class="muted"><a href="${article.url}">${article.url}</a></p><hr/>`;
      await notes.writeNoteContent(note.id, header + article.html);
      await create(article.title || article.url, {
        url: article.url, createdAt: new Date().toISOString(), tags: ["clipped"],
        desc: article.excerpt,
      });
      await refresh();
      toast("Clipped to Notes + Bookmarks", "ph-scissors");
      setReaderUrl(null);
    } catch (err) {
      console.error("Clip failed:", err);
      toast("Couldn't save the clip.", "ph-warning");
    }
  };

  const handleWebClipper = async () => {
    const r = await modal.form({ panel: true,
      title: "Web Clipper", icon: "ph-scissors", accent: "var(--h-bookmarks)", submitLabel: "Fetch & clip",
      fields: [{ name: "url", label: "Page URL", type: "url", defaultValue: "https://", placeholder: "https://…", required: true }],
    });
    if (!r) return;
    toast("Fetching page…", "ph-download");
    try {
      const article = await fetchReadableArticle(r.url);
      await clipArticle(article);
    } catch (err) {
      console.error("Web clip failed:", err);
      modal.confirm({ title: "Clip failed", message: String(err), icon: "ph-warning", danger: true, confirmLabel: "OK" });
    }
  };

  const handleOpenUrl = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    try { await openUrl(url); }
    catch (err) { console.error("Failed to open URL:", err); toast("Could not open the link.", "ph-warning"); }
  };

  const handleUrlDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const data = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (data && /^https?:\/\/[^\s]+$/i.test(data.trim())) {
      const url = data.trim();
      let title = url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40);
      let desc = "";
      let previewImg = "";
      try {
        const res = await fetch(`https://api.microlink.io?url=${encodeURIComponent(url)}`).catch(() => null);
        if (res && res.ok) {
           const json = await res.json();
           if (json.data?.title) title = json.data.title;
           if (json.data?.description) desc = json.data.description;
           if (json.data?.image?.url) previewImg = json.data.image.url;
        }
      } catch {
        // Metadata fetch is best-effort enrichment; fall back to the raw URL.
      }
      const r = await modal.form({ panel: true,
        title: "Add bookmark", icon: "ph-bookmark-simple", accent: "var(--h-bookmarks)", submitLabel: "Add bookmark",
        fields: [
          { name: "title", label: "Title", defaultValue: title, required: true },
          { name: "url", label: "URL", type: "url", defaultValue: url, required: true },
        ],
      });
      if (!r) return;
      try {
        await create(r.title, { url: r.url, createdAt: new Date().toISOString(), tags: [], desc, previewImg });
        toast("Bookmark added", "ph-bookmark");
      } catch (err) {
        console.error("Failed to create bookmark:", err);
      }
    }
  };

  useEffect(() => {
    const handleGlobalDrop = async (e: Event) => {
      const customEvent = e as CustomEvent;
      const paths = customEvent.detail?.paths;
      if (!paths || paths.length === 0) return;

      for (const p of paths) {
        const ext = p.split(".").pop()?.toLowerCase() || "";
        if (ext === "url" || ext === "webloc" || ext === "txt" || ext === "md") {
          try {
            const content = await fsReadNoteContent(p);
            let url = "";
            let title = p.split(/[\/\\]/).pop()?.replace(/\.[^/.]+$/, "") || "New Bookmark";

            if (ext === "url") {
              const match = content.match(/URL=(https?:\/\/[^\s\r\n]+)/i);
              if (match) url = match[1];
            } else if (ext === "webloc") {
              const match = content.match(/<string>(https?:\/\/[^\s\r\n<]+)<\/string>/i);
              if (match) url = match[1];
            } else {
              const match = content.match(/(https?:\/\/[^\s\r\n\)\"\'\>]+)/i);
              if (match) url = match[1];
            }

            if (url) {
              const r = await modal.form({ panel: true,
                title: "Add bookmark", icon: "ph-bookmark-simple", accent: "var(--h-bookmarks)", submitLabel: "Add bookmark",
                fields: [
                  { name: "title", label: "Title", defaultValue: title, required: true },
                  { name: "url", label: "URL", type: "url", defaultValue: url, required: true },
                ],
              });
              if (!r) continue;
              await create(r.title, { url: r.url, createdAt: new Date().toISOString(), tags: [] });
              toast("Bookmark added", "ph-bookmark");
            } else {
              toast(`No URL found inside ${title}.${ext}`, "ph-warning");
            }
          } catch (err) {
            console.error(err);
            toast(`Failed to read or parse shortcut: ${p}`, "ph-warning");
          }
        } else {
          toast(`Unsupported shortcut format: .${ext}`, "ph-warning");
        }
      }
    };

    window.addEventListener("loom-file-drop", handleGlobalDrop);
    return () => {
      window.removeEventListener("loom-file-drop", handleGlobalDrop);
    };
  }, [create, modal, toast]);

  const handleAdd = async () => {
    const r = await modal.form({ panel: true,
      title: "Add bookmark", icon: "ph-bookmark-simple", accent: "var(--h-bookmarks)", submitLabel: "Add bookmark",
      fields: [
        { name: "title", label: "Title", placeholder: "Bookmark name…", required: true },
        { name: "url", label: "URL", type: "url", defaultValue: "https://", placeholder: "https://…", required: true },
      ],
    });
    if (!r) return;
    try {
      await create(r.title, { url: r.url, createdAt: new Date().toISOString(), tags: [] });
      toast("Bookmark added", "ph-bookmark");
    } catch (err) {
      console.error("Failed to create bookmark:", err);
    }
  };

  const handleEdit = async (e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const meta = getBookmarkMeta(item);
    const r = await modal.form({ panel: true,
      title: "Edit bookmark", icon: "ph-pencil", accent: "var(--h-bookmarks)", submitLabel: "Save changes",
      fields: [
        { name: "title", label: "Title", defaultValue: item.title, required: true },
        { name: "url", label: "URL", type: "url", defaultValue: meta.url, required: true },
      ],
    });
    if (!r) return;
    try {
      if (r.title !== item.title) await updateFields(item.id, r.title, "bookmark");
      if (r.url !== meta.url) await updateMeta(item.id, { ...meta, url: r.url });
      toast("Bookmark updated", "ph-pencil");
    } catch (err) {
      console.error("Failed to update bookmark:", err);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation();
    const ok = await modal.confirm({ title: "Delete bookmark", message: `Delete "${title}"? This cannot be undone.`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    try { await remove(id); toast("Bookmark deleted", "ph-trash"); }
    catch (err) { console.error("Failed to delete bookmark:", err); }
  };

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-bookmarks)" } as any}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleUrlDrop}
    >
      <PageHead mod="var(--h-bookmarks)" icon="ph-bookmark-simple" kicker="Bookmarks" title="Saved for reference"
        sub={`${items.length} saved · web links and in-app items`}>
        <div className="seg">
          <button className={cx(kind === "all" && "on")} onClick={() => setKind("all")}>All</button>
          <button className={cx(kind === "web" && "on")} onClick={() => setKind("web")}>Web</button>
          <button className={cx(kind === "app" && "on")} onClick={() => setKind("app")}>In-app</button>
        </div>
        <button className="btn outline" onClick={handleWebClipper}>
          <I n="ph-scissors" /> Web Clipper
        </button>
        <button className="btn primary" onClick={handleAdd}><I n="ph-plus" w="bold" /> Add bookmark</button>
      </PageHead>
      <div className="vault-grid">
        {loading ? (
          <div className="muted" style={{ padding: "20px 0" }}>Loading bookmarks...</div>
        ) : items.length === 0 ? (
          <EmptyState icon="ph-bookmark-simple" mod="var(--h-bookmarks)" title="No bookmarks yet" sub="Save a web link here, or bookmark any note, task, or item from its Connections panel.">
            <button className="btn primary sm" style={{ marginTop: 12 }} onClick={handleAdd}><I n="ph-plus" w="bold" /> Add bookmark</button>
          </EmptyState>
        ) : cards.map(({ item: b, meta, isInternal, target, mod }) => {
          const onOpen = () => (isInternal && meta.targetId ? inspect(meta.targetId) : inspect(b.id));
          return (
            <div key={b.id} className="vault-card" style={{ "--mod": mod, position: "relative" } as any} onClick={onOpen} {...clickable(onOpen)}>
              <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4, zIndex: 10 }}>
                {!isInternal && meta.url && (
                  <>
                    <button className="btn icon sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: 4 }} onClick={(e) => { e.stopPropagation(); setReaderUrl(meta.url); }} title="Reader View">
                      <I n="ph-book-open" style={{ color: "var(--text-faint)" }} />
                    </button>
                    <button className="btn icon sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: 4 }} onClick={(e) => handleOpenUrl(e, meta.url)} title="Open in browser">
                      <I n="ph-arrow-square-out" style={{ color: "var(--text-faint)" }} />
                    </button>
                  </>
                )}
                {!isInternal && (
                  <button className="btn icon sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: 4 }} onClick={(e) => handleEdit(e, b)} title="Edit">
                    <I n="ph-pencil" style={{ color: "var(--text-faint)" }} />
                  </button>
                )}
                <button className="btn icon sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: 4 }} onClick={(e) => handleDelete(e, b.id, b.title)} title="Delete">
                  <I n="ph-trash" style={{ color: "var(--text-faint)" }} />
                </button>
              </div>
              <div className="vault-ico">
                <I n={isInternal ? (target?.icon || TYPE_ICON[meta.targetType || ""] || "ph-bookmark-simple") : "ph-bookmark-simple"} w="fill" />
              </div>
              <div className="vault-main" style={{ paddingRight: 60 }}>
                <div className="vault-t">{b.title}</div>
                <div className="vault-s" style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                  {isInternal
                    ? <span><I n="ph-arrow-bend-up-right" /> {TYPE_LABEL[meta.targetType || target?.type || ""] || "Item"} in LOOM{target ? ` · ${target.title}` : " · (deleted)"}</span>
                    : <a href={meta.url} onClick={(e) => { e.preventDefault(); handleOpenUrl(e, meta.url); }}>{meta.url}</a>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {readerUrl && <ReaderView url={readerUrl} onClose={() => setReaderUrl(null)} onClip={clipArticle} />}
    </div>
  );
}
