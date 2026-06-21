import { useState } from "react";
import * as Switch from "@radix-ui/react-switch";
import { I, cx, useLoom } from "../../lib/context";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { bgImportImage, bgResolvePath, bgDeleteManaged, bgSaveImageBytes } from "../../ipc/fs";
import { BackgroundConfig, BgFit } from "../../lib/settings";
import { themeStore, useThemeStore } from "../../lib/themeStore";
import { processBackground } from "../../lib/backgroundEngine";

const FITS: { id: BgFit; label: string }[] = [
  { id: "cover", label: "Cover" },
  { id: "contain", label: "Contain" },
  { id: "fill", label: "Fill" },
  { id: "center", label: "Center" },
];

// blur is px; the rest are unitless multipliers (1 = unchanged). value/scale keeps the
// slider integer-friendly while the stored config stays in real units.
const SLIDERS: { key: keyof BackgroundConfig; label: string; min: number; max: number; step: number }[] = [
  { key: "blur", label: "Blur", min: 0, max: 40, step: 1 },
  { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  { key: "brightness", label: "Brightness", min: 0, max: 2, step: 0.01 },
  { key: "contrast", label: "Contrast", min: 0, max: 2, step: 0.01 },
  { key: "saturation", label: "Saturation", min: 0, max: 2, step: 0.01 },
];

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });
}

// GIFs animate in CSS; the requirement is first-frame only. The picked GIF is already
// copied into managed storage (so it's in the asset scope) — load it, draw the first
// frame to a canvas, re-encode as PNG, persist those bytes, and drop the GIF copy.
async function freezeGifFirstFrame(gifRel: string): Promise<string> {
  const abs = await bgResolvePath(gifRel);
  const img = await loadImage(convertFileSrc(abs));
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2d context");
  ctx.drawImage(img, 0, 0); // first frame only
  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("PNG encode failed"))), "image/png"),
  );
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  const pngRel = await bgSaveImageBytes("png", bytes);
  bgDeleteManaged(gifRel).catch(() => {}); // remove the animated copy; best-effort
  return pngRel;
}

// Premium Background Engine controls. Background config is owned by themeStore (the app's
// single source of truth); this panel reads it via useThemeStore and mutates through it.
export function BackgroundPanel() {
  const { toast } = useLoom();
  const { bg } = useThemeStore();
  const [isProcessing, setIsProcessing] = useState(false);

  const updateBg = (patch: Partial<BackgroundConfig>) =>
    themeStore.setBackground({ ...themeStore.get().bg, ...patch });

  const handlePickBg = async () => {
    let sel: string | null = null;
    try {
      const r = await open({ multiple: false, filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }] });
      sel = typeof r === "string" ? r : null;
    } catch { return; /* dialog cancelled */ }
    if (!sel) return;

    setIsProcessing(true);
    try {
      let rel = await bgImportImage(sel);
      if (rel.toLowerCase().endsWith(".gif")) rel = await freezeGifFirstFrame(rel);
      const absolute = await bgResolvePath(rel);

      // Apply immediately — display must NOT depend on image analysis. This is the
      // fix for "reports success but never renders": the image is on screen the
      // instant the path resolves, regardless of what analysis does next.
      themeStore.setBackground({ ...themeStore.get().bg, bgImage: rel, _resolvedPath: absolute, profile: null });
      toast("Background applied", "ph-image");

      // Palette + readability are a best-effort enhancement layered on top.
      try {
        const profile = await processBackground(convertFileSrc(absolute));
        themeStore.setBackground({ ...themeStore.get().bg, profile });
      } catch (e) {
        console.error("Background analysis failed (image still applied):", e);
      }
    } catch (e) {
      console.error("Background import failed:", e);
      toast("Failed to load image", "ph-warning");
    } finally {
      setIsProcessing(false);
    }
  };

  const clearBg = () => {
    if (bg.bgImage) bgDeleteManaged(bg.bgImage).catch(() => {});
    themeStore.setBackground({ ...themeStore.get().bg, bgImage: null, _resolvedPath: null, profile: null });
  };

  if (!bg) return null;
  const hasImage = !!bg.bgImage;
  return (
    <div className="ts-group">
      <div className="ts-group-h"><I n="ph-image" /> Background System</div>

      <div className="ts-field">
        <div className="ts-field-tx">
          <div className="l">Background Image</div>
          <div className="h">PNG, JPG, WEBP or GIF (first frame).</div>
        </div>
        <div className="ts-ctl" style={{ gap: 8 }}>
          {isProcessing ? <span className="mono-sm ghost">Processing...</span> :
            hasImage ? (
              <>
                <span className="mono-sm" title={bg.bgImage!} style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {bg.bgImage!.split(/[\/\\]/).pop()}
                </span>
                <button className="btn sm" onClick={clearBg} title="Remove background"><I n="ph-x" /> Clear</button>
              </>
            ) : (
              <button className="btn sm" onClick={handlePickBg}><I n="ph-image" /> Browse</button>
            )}
        </div>
      </div>

      {hasImage && (
        <>
          <div className="ts-field">
            <div className="ts-field-tx">
              <div className="l">Fit</div>
              <div className="h">How the image fills the window.</div>
            </div>
            <div className="seg">
              {FITS.map((f) => (
                <button key={f.id} className={cx(bg.fit === f.id && "on")} onClick={() => updateBg({ fit: f.id })}>{f.label}</button>
              ))}
            </div>
          </div>

          {SLIDERS.map((s) => {
            const val = bg[s.key] as number;
            return (
              <div className="ts-field" key={s.key}>
                <div className="ts-field-tx">
                  <div className="l">{s.label}</div>
                </div>
                <div className="ts-ctl" style={{ gap: 8, minWidth: 160 }}>
                  <input
                    type="range"
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    value={val}
                    onChange={(e) => updateBg({ [s.key]: parseFloat(e.target.value) } as Partial<BackgroundConfig>)}
                    style={{ flex: 1, accentColor: "var(--accent)" }}
                  />
                  <span className="mono-sm ghost" style={{ width: 38, textAlign: "right" }}>
                    {s.key === "blur" ? `${Math.round(val)}px` : val.toFixed(2)}
                  </span>
                </div>
              </div>
            );
          })}
        </>
      )}

      <div className="ts-field">
        <div className="ts-field-tx">
          <div className="l">Readability Engine</div>
          <div className="h">Dynamic background blurring and darkening for UI contrast.</div>
        </div>
        <Switch.Root className="rx-switch" checked={bg.bgDynamic} onCheckedChange={(v) => updateBg({ bgDynamic: v })} disabled={!hasImage}>
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
        <Switch.Root className="rx-switch" checked={bg.bgParallax} onCheckedChange={(v) => updateBg({ bgParallax: v })} disabled={!hasImage}>
          <Switch.Thumb className="rx-switch-thumb" />
        </Switch.Root>
      </div>
    </div>
  );
}
