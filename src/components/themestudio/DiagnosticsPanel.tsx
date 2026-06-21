import { useState, useEffect, useRef, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { I } from "../../lib/context";
import { useThemeStore } from "../../lib/themeStore";
import { analyzeTheme, domProbe, checkBackgroundImage, Diagnostic } from "../../lib/themeDiagnostics";

// Theme health check. Runs the five diagnostics against the live document (so it sees the
// resolved theme, not just raw tokens) and lists one actionable fix per issue. Re-runs
// automatically when tokens or the background change, debounced so a slider drag is cheap.
export function DiagnosticsPanel({ tokens }: { tokens: Record<string, string> }) {
  const { bg } = useThemeStore();
  const [issues, setIssues] = useState<Diagnostic[]>([]);
  const [ran, setRan] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const run = useCallback(async () => {
    // Sync checks read the live computed styles; the image check is async.
    const sync = analyzeTheme(domProbe(tokens));
    const imgUrl = bg.bgImage ? convertFileSrc(bg._resolvedPath ?? bg.bgImage) : null;
    const img = await checkBackgroundImage(imgUrl);
    setIssues(img ? [...sync, img] : sync);
    setRan(true);
  }, [tokens, bg.bgImage, bg._resolvedPath]);

  // Debounced auto-run on any theme/background change (and once on mount).
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { run(); }, 350);
    return () => window.clearTimeout(timer.current);
  }, [run]);

  const errors = issues.filter((i) => i.severity === "error").length;

  return (
    <div className="ts-group">
      <div className="ts-group-h">
        <I n="ph-heartbeat" /> Diagnostics
        <span className="ts-spacer" />
        <button className="btn icon sm" onClick={run} title="Re-run checks" aria-label="Re-run diagnostics">
          <I n="ph-arrows-clockwise" />
        </button>
      </div>

      {ran && issues.length === 0 && (
        <div className="ts-diag-ok"><I n="ph-check-circle" w="fill" /> All checks passed — valid colours, readable contrast, fonts and image all resolve.</div>
      )}

      {issues.length > 0 && (
        <div className="ts-diag-list">
          {issues.length > 0 && (
            <div className="ts-diag-sum mono-sm ghost">
              {errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : ""}{errors > 0 && issues.length - errors > 0 ? " · " : ""}
              {issues.length - errors > 0 ? `${issues.length - errors} warning${issues.length - errors === 1 ? "" : "s"}` : ""}
            </div>
          )}
          {issues.map((d, i) => (
            <div key={i} className={"ts-diag " + d.severity}>
              <I n={d.severity === "error" ? "ph-warning-octagon" : "ph-warning"} w="fill" />
              <div className="ts-diag-tx">
                <div className="ts-diag-cat">{d.category}</div>
                <div className="ts-diag-msg">{d.message}</div>
                <div className="ts-diag-fix"><I n="ph-wrench" /> {d.fix}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
