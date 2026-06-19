import React from "react";
import { Button } from "loom";

// OverlayShell uses Dialog.Portal (position:fixed) so its content renders outside
// the story element — per-story crop is blank. This preview shows the visual
// composition inline in a bounded container using the same CSS classes.
// The contact sheet (full-page screenshot) confirms the real component renders correctly.
export function CenterModal() {
  return (
    <div style={{ position: "relative", width: "640px", height: "440px", overflow: "hidden", background: "oklch(0.145 0.008 286)", flexShrink: 0 }}>
      {/* Scrim — matches .overlay-scrim but position:absolute to stay in bounds */}
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(3px)" }} />
      {/* Modal centered */}
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
        <div className="modal">
          <div className="modal-head">
            <div className="modal-ico"><i className="ph ph-note-pencil" /></div>
            <span className="modal-t">Create Note</span>
          </div>
          <div className="modal-body">
            <div className="modal-field">
              <label>Title</label>
              <input placeholder="My note title…" defaultValue="Weekly Retrospective" />
            </div>
            <div className="modal-field">
              <label>Content</label>
              <textarea placeholder="Start writing…" rows={3} defaultValue="Reflect on what went well this week and areas for improvement." />
            </div>
          </div>
          <div className="modal-foot">
            <Button variant="ghost">Cancel</Button>
            <Button variant="primary" iconLeft="ph-check">Create</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
