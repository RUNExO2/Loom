import { useState, useEffect } from "react";
import { I } from "../lib/context";
import { fetchReadableArticle, ReadableArticle } from "../ipc/content";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as Dialog from "@radix-ui/react-dialog";

// Clean in-app reader. Fetches + extracts the article via the Rust backend (real work,
// no fake state). Optionally exposes a "Clip" action so the Web Clipper can persist it.
export function ReaderView({
  url,
  onClose,
  onClip,
}: {
  url: string;
  onClose: () => void;
  onClip?: (article: ReadableArticle) => void | Promise<void>;
}) {
  const [article, setArticle] = useState<ReadableArticle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clipping, setClipping] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setArticle(null);
    fetchReadableArticle(url)
      .then((a) => { if (alive) { setArticle(a); setLoading(false); } })
      .catch((e) => { if (alive) { setError(String(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [url]);



  const handleClip = async () => {
    if (!article || !onClip) return;
    setClipping(true);
    try { await onClip(article); }
    finally { setClipping(false); }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay asChild>
          <div className="reader-scrim">
            <Dialog.Content asChild aria-describedby={undefined}>
              <div className="reader-shell" onClick={(e) => e.stopPropagation()}>
                <Dialog.Title className="sr-only">Reader view</Dialog.Title>
                <div className="reader-bar">
                  <div className="row gap8" style={{ minWidth: 0, flex: 1 }}>
                    <I n="ph-book-open" style={{ color: "var(--accent)" }} />
                    <span className="mono-sm ghost" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {article?.site_name || (() => { try { return new URL(url).hostname; } catch { return url; } })()}
                    </span>
                  </div>
                  <div className="row gap6">
                    {onClip && article && (
                      <button className="btn sm" onClick={handleClip} disabled={clipping} title="Save a clean copy to Notes">
                        <I n={clipping ? "ph-spinner" : "ph-scissors"} /> {clipping ? "Clipping…" : "Clip to Notes"}
                      </button>
                    )}
                    <button className="btn sm" onClick={() => openUrl(url).catch(console.error)} title="Open original in browser">
                      <I n="ph-arrow-square-out" /> Original
                    </button>
                    <Dialog.Close asChild>
                      <button className="btn icon sm" aria-label="Close reader"><I n="ph-x" /></button>
                    </Dialog.Close>
                  </div>
                </div>

                <div className="reader-body">
                  {loading ? (
                    <div className="muted" style={{ padding: "60px 0", textAlign: "center" }}>
                      <I n="ph-spinner" /> Fetching and cleaning the article…
                    </div>
                  ) : error ? (
                    <div className="muted" style={{ padding: "40px 0", textAlign: "center" }}>
                      <div style={{ fontSize: 28, marginBottom: 8 }}><I n="ph-warning-circle" /></div>
                      <div style={{ color: "var(--text)" }}>Couldn't open this in Reader View.</div>
                      <div className="mono-sm ghost" style={{ marginTop: 6 }}>{error}</div>
                      <button className="btn sm" style={{ marginTop: 16 }} onClick={() => openUrl(url).catch(console.error)}>
                        <I n="ph-arrow-square-out" /> Open in browser instead
                      </button>
                    </div>
                  ) : article ? (
                    <article className="reader-article">
                      <h1>{article.title}</h1>
                      <div className="reader-meta">
                        {article.byline && <span><I n="ph-user" /> {article.byline}</span>}
                        <span><I n="ph-text-aa" /> {article.word_count.toLocaleString()} words</span>
                        <span><I n="ph-clock" /> {Math.max(1, Math.round(article.word_count / 220))} min read</span>
                      </div>
                      <div dangerouslySetInnerHTML={{ __html: article.html }} />
                    </article>
                  ) : null}
                </div>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
