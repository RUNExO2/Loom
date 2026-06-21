import { useState } from "react";
import * as Switch from "@radix-ui/react-switch";
import { I, cx, useLoom } from "../../lib/context";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { bgImportImage, bgResolvePath, bgDeleteManaged } from "../../ipc/fs";
import { BackgroundConfig } from "../../lib/settings";
import { themeStore, useThemeStore } from "../../lib/themeStore";
import { processBackground } from "../../lib/backgroundEngine";

// Premium Background Engine controls. Background config is owned by themeStore (the app's
// single source of truth); this panel reads it via useThemeStore and mutates through it.
export function BackgroundPanel() {
  const { toast } = useLoom();
  const { bg } = useThemeStore();
  const [isProcessing, setIsProcessing] = useState(false);

  const updateBg = (patch: Partial<BackgroundConfig>) => themeStore.setBackground({ ...bg, ...patch });

  const handlePickBg = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }] });
      if (!sel || typeof sel !== "string") return;
      setIsProcessing(true);
      try {
        // Copy into managed storage first — gives a clean, portable, sanitised path.
        const rel = await bgImportImage(sel);
        const absolute = await bgResolvePath(rel);
        const url = convertFileSrc(absolute);
        const profile = await processBackground(url);
        themeStore.setBackground({ ...bg, bgImage: rel, _resolvedPath: absolute, profile });
        toast("Background processed and applied", "ph-image");
      } catch {
        toast("Failed to process image", "ph-warning");
      } finally {
        setIsProcessing(false);
      }
    } catch { /* dialog cancelled */ }
  };

  const clearBg = () => {
    // Clean up the managed copy; fire-and-forget (missing file is harmless).
    if (bg.bgImage) bgDeleteManaged(bg.bgImage).catch(() => {});
    themeStore.setBackground({ ...bg, bgImage: null, _resolvedPath: null, profile: null });
  };

  if (!bg) return null;
  return (
    <div className="ts-group">
      <div className="ts-group-h"><I n="ph-image" /> Background System</div>

      <div className="ts-field">
        <div className="ts-field-tx">
          <div className="l">Background Image</div>
          <div className="h">Select an image for the Premium Background Engine.</div>
        </div>
        <div className="ts-ctl" style={{ gap: 8 }}>
          {isProcessing ? <span className="mono-sm ghost">Processing...</span> :
            bg.bgImage ? (
              <>
                <span className="mono-sm" title={bg.bgImage} style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {bg.bgImage.split(/[\/\\]/).pop()}
                </span>
                <button className="btn sm" onClick={clearBg} title="Remove background"><I n="ph-x" /> Clear</button>
              </>
            ) : (
              <button className="btn sm" onClick={handlePickBg}><I n="ph-image" /> Browse</button>
            )}
        </div>
      </div>

      <div className="ts-field">
        <div className="ts-field-tx">
          <div className="l">Readability Engine</div>
          <div className="h">Dynamic background blurring and darkening for UI contrast.</div>
        </div>
        <Switch.Root className="rx-switch" checked={bg.bgDynamic} onCheckedChange={(v) => updateBg({ bgDynamic: v })} disabled={!bg.bgImage}>
          <Switch.Thumb className="rx-switch-thumb" />
        </Switch.Root>
      </div>

      <div className="ts-field">
        <div className="ts-field-tx">
          <div className="l">Extract Palette</div>
          <div className="h">Use image colors for the app accent and surface tint.</div>
        </div>
        <div className="ts-ctl">
          <button className={cx("btn sm", bg.bgUseColors && "active")} onClick={() => updateBg({ bgUseColors: !bg.bgUseColors })}>
            <I n={bg.bgUseColors ? "ph-check-circle" : "ph-circle"} /> Extract Colors
          </button>
        </div>
      </div>

      <div className="ts-field">
        <div className="ts-field-tx">
          <div className="l">Enable Parallax</div>
          <div className="h">Slightly shift the background with mouse movement.</div>
        </div>
        <Switch.Root className="rx-switch" checked={bg.bgParallax} onCheckedChange={(v) => updateBg({ bgParallax: v })} disabled={!bg.bgImage}>
          <Switch.Thumb className="rx-switch-thumb" />
        </Switch.Root>
      </div>
    </div>
  );
}
