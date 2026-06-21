import { I, cx, useLoom } from "../../lib/context";

// Sidebar vs titlebar-pill navigation. navStyle lives in app context, not the theme model.
export function NavPanel() {
  const { navStyle, setNavStyle } = useLoom();
  return (
    <div className="ts-group">
      <div className="ts-group-h"><I n="ph-layout" /> Navigation System</div>
      <div className="ts-field">
        <div className="ts-field-tx">
          <div className="l">Navigation Style</div>
          <div className="h">Choose between a traditional sidebar or compact titlebar pills.</div>
        </div>
        <div className="ts-ctl" style={{ gap: 8 }}>
          <div className="modal-seg">
            <button className={cx(navStyle === "sidebar" && "on")} onClick={() => setNavStyle("sidebar")}>
              <I n="ph-sidebar-simple" /> Sidebar
            </button>
            <button className={cx(navStyle === "top-pill" && "on")} onClick={() => setNavStyle("top-pill")}>
              <I n="ph-browser" /> Top Pills
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
