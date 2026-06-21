import { I } from "../../lib/context";
import { MANAGED_VAR_KEYS, composeFilter } from "../../lib/theme";

// Living specimen — a miniature LOOM that re-paints from the edited tokens. Two-way:
//  • hover a control → `hi` glows the region it governs
//  • click a region → `onTarget(region)` jumps focus to the first control that governs it
function regionProps(region: string, onTarget: (r: string) => void) {
  return {
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); onTarget(region); },
    title: "Jump to this control",
  };
}

export function LivePreview({ tokens, hi, onTarget }: {
  tokens: Record<string, string>;
  hi: string | null;
  onTarget: (region: string) => void;
}) {
  const vars: Record<string, string> = {};
  for (const k of MANAGED_VAR_KEYS) { const v = tokens[k]; if (v) vars[k] = v; }
  const filter = composeFilter(tokens);
  const screenStyle = { ...vars, ...(filter ? { filter } : {}) } as any;
  const g = (name: string) => (hi === name ? " ts-glow" : "");
  const t = (region: string) => regionProps(region, onTarget);

  return (
    <div className="ts-stage">
      <div className="ts-stage-label mono-sm ghost">Live specimen</div>
      <div className={"tsp-screen ts-target" + g("bg")} style={screenStyle} {...t("bg")}>
        <div className="tsp-bar">
          <span className="tsp-dots"><i /><i /><i /></span>
          <span className={"tsp-wm ts-target" + g("title")} {...t("title")}>LOOM</span>
          <span className="tsp-search" />
        </div>
        <div className="tsp-body">
          <div className="tsp-side">
            <span className="tsp-nav on"><I n="ph-squares-four" /> Home</span>
            <span className="tsp-nav"><I n="ph-note" /> Notes</span>
            <span className="tsp-nav"><I n="ph-check-square" /> Tasks</span>
          </div>
          <div className="tsp-main">
            <span className="tsp-kicker">Workspace</span>
            <span className={"tsp-title ts-target" + g("title") + g("text")} {...t("text")}>Good evening</span>

            <div className={"tsp-card ts-target" + g("surface") + g("border") + g("card")} {...t("surface")}>
              <div className="tsp-card-h">
                <span className="tsp-ico"><I n="ph-target" w="fill" /></span>
                <span className="tsp-card-t">Today</span>
                <span className="tsp-count">2 / 3</span>
              </div>
              <div className="tsp-row"><span className="tsp-chk on"><I n="ph-check" w="bold" /></span> Ship the theme studio</div>
              <div className="tsp-row"><span className="tsp-chk" /> Review pull request</div>
              <div className="tsp-bar2"><i /></div>
            </div>

            <div className={"tsp-actions ts-target" + g("accent")} {...t("accent")}>
              <span className="tsp-btn pri">Save</span>
              <span className="tsp-btn gh">Cancel</span>
              <span className="tsp-tag">focus</span>
              <span className="tsp-toggle"><i /></span>
            </div>

            <div className={"tsp-reader ts-target" + g("reader")} {...t("reader")}>Reading view  -  calm long-form text.</div>
            <div className={"tsp-graph ts-target" + g("graph")} {...t("graph")}><span className="nd" /><span className="ed" /><span className="nd" /><span className="ed" /><span className="nd" /></div>
            <div className="tsp-seltx">Select <span className={"tsp-sel ts-target" + g("accent")} {...t("accent")}>this highlight</span> sample.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
