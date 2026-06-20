// Workspace templates: seed a workspace with a coherent set of starter notes so a new
// space isn't a blank slate. Each template is just a list of notes (title + HTML body)
// created through the normal note pipeline — no special storage.

import { fsCreateNote, fsWriteNoteContent } from "../ipc/fs";

export interface TemplateNote { title: string; html: string }
export interface WorkspaceTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  notes: TemplateNote[];
}

export const WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
  {
    id: "pkb",
    name: "Knowledge Base",
    icon: "ph-brain",
    description: "A Zettelkasten-style home, an index, and a sample linked note.",
    notes: [
      { title: "📥 Inbox", html: "<h1>Inbox</h1><p>Capture anything here first, then file it. Press <code>/</code> for commands.</p><ul data-type=\"taskList\"><li data-checked=\"false\"><label><input type=\"checkbox\"></label><div>Process the inbox weekly</div></li></ul>" },
      { title: "🗂 Index", html: "<h1>Index</h1><p>Your map of content — link out to the notes that matter.</p><ul><li>Topic A</li><li>Topic B</li></ul>" },
      { title: "💡 Concepts", html: "<h1>Concepts</h1><p>One idea per note. Keep them atomic and link them together.</p><blockquote>The best note is the one you can find again.</blockquote>" },
    ],
  },
  {
    id: "projects",
    name: "Project Hub",
    icon: "ph-kanban",
    description: "A project brief, a meeting-notes page, and a decisions log.",
    notes: [
      { title: "Project Brief", html: "<h1>Project Brief</h1><h2>Goal</h2><p>What success looks like.</p><h2>Scope</h2><ul><li>In scope</li><li>Out of scope</li></ul><h2>Milestones</h2><ul data-type=\"taskList\"><li data-checked=\"false\"><label><input type=\"checkbox\"></label><div>Kickoff</div></li><li data-checked=\"false\"><label><input type=\"checkbox\"></label><div>Beta</div></li></ul>" },
      { title: "Meeting Notes", html: "<h1>Meeting Notes</h1><h3>Attendees</h3><p></p><h3>Discussion</h3><ul><li></li></ul><h3>Action items</h3><ul data-type=\"taskList\"><li data-checked=\"false\"><label><input type=\"checkbox\"></label><div></div></li></ul>" },
      { title: "Decisions Log", html: "<h1>Decisions Log</h1><blockquote>Record each decision, the date, and why — so future-you knows.</blockquote><p></p>" },
    ],
  },
  {
    id: "journal",
    name: "Daily Journal",
    icon: "ph-notebook",
    description: "A journaling guide and your first daily entry.",
    notes: [
      { title: "How I Journal", html: "<h1>How I Journal</h1><p>Three prompts, every day:</p><ol><li>What happened?</li><li>How did I feel?</li><li>What's next?</li></ol>" },
      { title: "Daily Entry", html: "<h1>Daily Entry</h1><h3>Grateful for</h3><ul><li></li></ul><h3>Today</h3><p></p><h3>Tomorrow</h3><ul data-type=\"taskList\"><li data-checked=\"false\"><label><input type=\"checkbox\"></label><div></div></li></ul>" },
    ],
  },
];

// Create every note in a template. Returns the number of notes created.
export async function applyWorkspaceTemplate(workspaceId: string, tpl: WorkspaceTemplate): Promise<number> {
  for (const n of tpl.notes) {
    const note = await fsCreateNote(workspaceId, n.title);
    await fsWriteNoteContent(note.id, n.html);
  }
  return tpl.notes.length;
}
