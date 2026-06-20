import React, { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, Editor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle, FontSize } from "@tiptap/extension-text-style";
import { Image } from "@tiptap/extension-image";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extension-placeholder";
import { MediaEmbed } from "./MediaEmbed";
import { useModal } from "./Modal";
import { I } from "../lib/context";

// Imperative handle so the parent's existing actions (attach file, AI summarize,
// auto-tag) can read/insert content without owning the editor instance.
export interface NoteEditorApi {
  getHTML: () => string;
  getText: () => string;
  insertHTML: (html: string) => void;
  focus: () => void;
  editor: Editor | null;
}

// Font size uses TipTap v3's built-in FontSize mark (on textStyle), replacing the
// old execCommand("fontSize") + <font> tag rewriting hack.

// Preserve attachment cards from legacy notes (<a data-attachment class="attachment-card">)
// across an edit/save round-trip so the click-to-open pointer is never lost.
const LinkExtras = Extension.create({
  name: "linkExtras",
  addGlobalAttributes() {
    return [{
      types: ["link"],
      attributes: {
        "data-attachment": {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment"),
          renderHTML: (attrs: any) => attrs["data-attachment"] ? { "data-attachment": attrs["data-attachment"] } : {},
        },
        class: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute("class"),
          renderHTML: (attrs: any) => attrs.class ? { class: attrs.class } : {},
        },
      },
    }];
  },
});

const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 32, 48];

// Pure: given the text from line-start to cursor, return the active "/query" token
// (query text after the slash) or null if the cursor isn't in a slash command.
export function matchSlash(textBefore: string): { query: string } | null {
  const m = textBefore.match(/(?:^|\s)\/([^\s/]*)$/);
  return m ? { query: m[1] } : null;
}

interface SlashItem { id: string; label: string; icon: string; keywords: string; run: (e: Editor) => void; }

const SLASH_ITEMS: SlashItem[] = [
  { id: "h1", label: "Heading 1", icon: "ph-text-h-one", keywords: "h1 heading title", run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", icon: "ph-text-h-two", keywords: "h2 heading subtitle", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: "h3", label: "Heading 3", icon: "ph-text-h-three", keywords: "h3 heading", run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: "ul", label: "Bullet List", icon: "ph-list-bullets", keywords: "ul bullet unordered list", run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "ol", label: "Numbered List", icon: "ph-list-numbers", keywords: "ol numbered ordered list", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "todo", label: "To-Do", icon: "ph-check-square", keywords: "todo task checkbox check", run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: "quote", label: "Quote", icon: "ph-quotes", keywords: "quote blockquote", run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: "code", label: "Code Block", icon: "ph-code", keywords: "code block pre", run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: "mermaid", label: "Mermaid Diagram", icon: "ph-graph", keywords: "mermaid diagram chart graph", run: (e) => e.chain().focus().insertContent({ type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: "graph TD;\nA-->B;" }] }).run() },
  { id: "hr", label: "Divider", icon: "ph-minus", keywords: "hr divider rule line", run: (e) => e.chain().focus().setHorizontalRule().run() },
];

export interface NoteEditorProps {
  apiRef: React.MutableRefObject<NoteEditorApi | null>;
  initialHtml: string;
  onChange: (html: string) => void;
  onSave: (html: string) => void;
  onDiscard: () => void;
  onAttach: () => void;
  onSummarize: () => void;
  onAutoTag: () => void;
  summarizing: boolean;
  /** Optional extra toolbar buttons (rich-media menu) rendered after the app actions. */
  extraTools?: (editor: Editor) => React.ReactNode;
}

export function NoteEditor({ apiRef, initialHtml, onChange, onSave, onDiscard, onAttach, onSummarize, onAutoTag, summarizing, extraTools }: NoteEditorProps) {
  const modal = useModal();
  const [, force] = useState(0); // re-render toolbar active states on selection change
  const [slash, setSlash] = useState<{ open: boolean; query: string; from: number; top: number; left: number; index: number }>(
    { open: false, query: "", from: 0, top: 0, left: 0, index: 0 },
  );
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const [fontSize, setFontSizeState] = useState(14);

  const filtered = useMemo(() => {
    const q = slash.query.toLowerCase();
    return q ? SLASH_ITEMS.filter((i) => i.keywords.includes(q) || i.label.toLowerCase().includes(q)) : SLASH_ITEMS;
  }, [slash.query]);
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  const closeSlash = () => setSlash((s) => ({ ...s, open: false }));

  const pickSlash = (item: SlashItem, ed: Editor) => {
    // Remove the "/query" token, then run the command.
    const to = ed.state.selection.from;
    ed.chain().focus().deleteRange({ from: slashRef.current.from, to }).run();
    item.run(ed);
    closeSlash();
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Links handled by StarterKit's bundled Link; keep data-attachment via LinkExtras.
        link: { openOnClick: false, autolink: false },
        codeBlock: { HTMLAttributes: {} },
      }),
      TextStyle,
      FontSize,
      LinkExtras,
      Image.configure({ inline: false, allowBase64: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      MediaEmbed,
      Placeholder.configure({ placeholder: "Start writing… press “/” for commands" }),
    ],
    content: initialHtml || "",
    editorProps: {
      attributes: { class: "note-editor-body", spellcheck: "true" },
      handleKeyDown: (_view, event) => {
        const s = slashRef.current;
        if (s.open) {
          const items = filteredRef.current;
          if (event.key === "ArrowDown") { setSlash((p) => ({ ...p, index: (p.index + 1) % Math.max(items.length, 1) })); return true; }
          if (event.key === "ArrowUp") { setSlash((p) => ({ ...p, index: (p.index - 1 + items.length) % Math.max(items.length, 1) })); return true; }
          if (event.key === "Enter" || event.key === "Tab") {
            const item = items[s.index];
            if (item && editorInstance.current) { pickSlash(item, editorInstance.current); return true; }
          }
          if (event.key === "Escape") { closeSlash(); return true; }
        } else if (event.key === "Escape") {
          onDiscard(); return true;
        }
        if (event.key === "s" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          onSave(editorInstance.current?.getHTML() || "");
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
      detectSlash(editor);
      force((n) => n + 1);
    },
    onSelectionUpdate: ({ editor }) => { detectSlash(editor); force((n) => n + 1); },
  });

  // Stable ref to the editor for use inside callbacks created before render.
  const editorInstance = useRef<Editor | null>(null);
  editorInstance.current = editor;

  // Detect a "/" slash token at the cursor and position the menu.
  function detectSlash(ed: Editor) {
    const { from, empty } = ed.state.selection;
    if (!empty) { closeSlash(); return; }
    const $from = ed.state.selection.$from;
    const lineStart = $from.start();
    const textBefore = ed.state.doc.textBetween(lineStart, from, "\n", "\n");
    const m = matchSlash(textBefore);
    if (!m) { closeSlash(); return; }
    const slashFrom = from - m.query.length - 1;
    const coords = ed.view.coordsAtPos(from);
    setSlash((s) => ({ ...s, open: true, query: m.query, from: slashFrom, top: coords.bottom, left: coords.left, index: 0 }));
  }

  useEffect(() => {
    if (!editor) return;
    apiRef.current = {
      getHTML: () => editor.getHTML(),
      getText: () => editor.getText(),
      insertHTML: (html: string) => editor.chain().focus().insertContent(html).run(),
      focus: () => editor.commands.focus(),
      editor,
    };
    editor.commands.focus("end");
    return () => { apiRef.current = null; };
  }, [editor]);

  if (!editor) return null;

  const tb = (active: boolean) => (active ? "active" : "");
  const fmtBtn = (cmd: () => void, title: string, icon: string, active = false) => (
    <button className={tb(active)} onMouseDown={(e) => { e.preventDefault(); cmd(); }} title={title}><I n={icon} w="bold" /></button>
  );

  return (
    <div className="note-editor-container">
      <div className="note-editor-toolbar">
        {fmtBtn(() => editor.chain().focus().toggleBold().run(), "Bold", "ph-text-b", editor.isActive("bold"))}
        {fmtBtn(() => editor.chain().focus().toggleItalic().run(), "Italic", "ph-text-italic", editor.isActive("italic"))}
        {fmtBtn(() => editor.chain().focus().toggleUnderline().run(), "Underline", "ph-text-underline", editor.isActive("underline"))}
        {fmtBtn(() => editor.chain().focus().toggleStrike().run(), "Strikethrough", "ph-text-strikethrough", editor.isActive("strike"))}
        <div className="tb-sep" />
        <button className={tb(editor.isActive("heading", { level: 1 }))} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 1 }).run(); }} title="Heading 1"><span style={{ fontWeight: 800 }}>H1</span></button>
        <button className={tb(editor.isActive("heading", { level: 2 }))} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 2 }).run(); }} title="Heading 2"><span style={{ fontWeight: 650 }}>H2</span></button>
        <button className={tb(editor.isActive("heading", { level: 3 }))} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 3 }).run(); }} title="Heading 3"><span style={{ fontWeight: 550 }}>H3</span></button>
        <button className={tb(editor.isActive("paragraph"))} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().setParagraph().run(); }} title="Paragraph"><span>P</span></button>
        <div className="tb-sep" />
        {fmtBtn(() => editor.chain().focus().toggleBulletList().run(), "Bullet List", "ph-list-bullets", editor.isActive("bulletList"))}
        {fmtBtn(() => editor.chain().focus().toggleOrderedList().run(), "Numbered List", "ph-list-numbers", editor.isActive("orderedList"))}
        {fmtBtn(() => editor.chain().focus().toggleTaskList().run(), "Checklist", "ph-check-square", editor.isActive("taskList"))}
        <div className="tb-sep" />
        {fmtBtn(async () => {
          const prev = editor.getAttributes("link").href;
          const r = await modal.form({ title: "Insert link", icon: "ph-link", submitLabel: "Apply", fields: [{ name: "url", label: "URL", type: "url", defaultValue: prev || "https://", placeholder: "https://" }] });
          if (r === null) return;
          const url = (r.url || "").trim();
          if (url === "") { editor.chain().focus().unsetLink().run(); return; }
          editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
        }, "Insert Link", "ph-link", editor.isActive("link"))}
        {fmtBtn(() => editor.chain().focus().unsetLink().run(), "Remove Link", "ph-link-break")}
        <div className="tb-sep" />
        {fmtBtn(() => editor.chain().focus().toggleBlockquote().run(), "Blockquote", "ph-quotes", editor.isActive("blockquote"))}
        {fmtBtn(() => editor.chain().focus().toggleCodeBlock().run(), "Code Block", "ph-code", editor.isActive("codeBlock"))}
        <div className="tb-sep" />
        <select value={fontSize} onChange={(e) => { const v = parseInt(e.target.value); setFontSizeState(v); (editor.chain().focus() as any).setFontSize(`${v}px`).run(); }} title="Font size">
          {FONT_SIZES.map((s) => <option key={s} value={s}>{s}px</option>)}
        </select>
        <div className="tb-sep" />
        <button onMouseDown={(e) => { e.preventDefault(); onAttach(); }} title="Attach File"><I n="ph-paperclip" w="bold" /> Attach</button>
        {extraTools?.(editor)}
        <div className="tb-sep" />
        <button onMouseDown={(e) => { e.preventDefault(); onSummarize(); }} title="AI Summarize" disabled={summarizing}>
          <I n={summarizing ? "ph-spinner" : "ph-magic-wand"} w="bold" /> {summarizing ? "Thinking..." : "Summarize"}
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); onAutoTag(); }} title="Auto-Tag from content"><I n="ph-tag" w="bold" /> Auto-Tag</button>
        <div className="tb-sep" />
        {fmtBtn(() => editor.chain().focus().undo().run(), "Undo", "ph-arrow-counter-clockwise")}
        {fmtBtn(() => editor.chain().focus().redo().run(), "Redo", "ph-arrow-clockwise")}
      </div>

      {slash.open && filtered.length > 0 && (
        <div className="slash-menu" style={{ position: "fixed", top: slash.top + 5, left: slash.left, zIndex: 1000, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", boxShadow: "var(--shadow-md)", padding: 4, minWidth: 190 }}>
          <div className="muted" style={{ padding: "4px 8px", fontSize: "var(--fs-xs)", fontWeight: 600 }}>INSERT · ↑↓ navigate · ↵ select</div>
          {filtered.map((item, i) => (
            <button
              key={item.id}
              onMouseEnter={() => setSlash((s) => ({ ...s, index: i }))}
              onMouseDown={(e) => { e.preventDefault(); pickSlash(item, editor); }}
              className={cx2("slash-item", i === slash.index && "active")}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "6px 8px", background: i === slash.index ? "var(--surface-3)" : "transparent", border: "none", color: "var(--text)", cursor: "pointer", borderRadius: 4 }}
            >
              <I n={item.icon} /> {item.label}
            </button>
          ))}
        </div>
      )}

      <EditorContent editor={editor} />

      <div style={{ padding: "6px 16px", background: "var(--surface-2)", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }} className="mono-sm ghost">
        <span>Press “/” for commands · Escape to discard · Ctrl+S to save</span>
        <span>Autosaving…</span>
      </div>
    </div>
  );
}

function cx2(...a: (string | false | undefined)[]) { return a.filter(Boolean).join(" "); }
