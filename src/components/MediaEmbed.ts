import { Node, mergeAttributes } from "@tiptap/core";

export type MediaKind = "pdf" | "audio" | "video" | "web";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mediaEmbed: {
      setMediaEmbed: (attrs: { kind: MediaKind; src: string; title?: string }) => ReturnType;
    };
  }
}

// Normalize common share URLs to their embeddable form so "web embed" just works
// for the things people actually paste. Anything else is embedded verbatim.
export function toEmbedUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com" && u.searchParams.get("v")) return `https://www.youtube.com/embed/${u.searchParams.get("v")}`;
    if (host === "youtu.be") return `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    if (host === "vimeo.com") return `https://player.vimeo.com/video/${u.pathname.split("/").filter(Boolean)[0]}`;
    return url;
  } catch {
    return url;
  }
}

// One node for every rich embed (pdf / audio / video / web). It renders to real
// <iframe>/<video>/<audio> tags so the read-only view (dangerouslySetInnerHTML)
// shows live media without any JS, and parses them back for editing — round-trips
// through the on-disk HTML store with no data loss.
export const MediaEmbed = Node.create({
  name: "mediaEmbed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: "web", parseHTML: (el) => el.getAttribute("data-media") || "web" },
      src: { default: null, parseHTML: (el) => el.getAttribute("src") },
      title: { default: null, parseHTML: (el) => el.getAttribute("title") },
    };
  },

  parseHTML() {
    return [
      { tag: "iframe[data-media]" },
      { tag: "video[data-media]" },
      { tag: "audio[data-media]" },
    ];
  },

  renderHTML({ node }) {
    const kind = node.attrs.kind as MediaKind;
    const common: Record<string, any> = {
      "data-media": kind,
      src: node.attrs.src,
      class: `media-embed media-${kind}`,
    };
    if (node.attrs.title) common.title = node.attrs.title;
    if (kind === "video") return ["video", mergeAttributes(common, { controls: "true", preload: "metadata" })];
    if (kind === "audio") return ["audio", mergeAttributes(common, { controls: "true", preload: "metadata" })];
    // pdf + web both render as an iframe
    return ["iframe", mergeAttributes(common, { frameborder: "0", allowfullscreen: "true", loading: "lazy" })];
  },

  addCommands() {
    return {
      setMediaEmbed: (attrs) => ({ commands }) =>
        commands.insertContent({ type: this.name, attrs }),
    };
  },
});
