// ── Palette generation ────────────────────────────────────────────────────────
// Turns raw colors pulled from a background image into a consistent, ACCESSIBLE set
// of theme tokens. Pure math, no DOM — so it's trivially testable and runs both at
// extraction time and live in renderCombined (which re-derives per theme family so
// dark/light variants adapt when you switch themes).
//
// Two color spaces are used deliberately:
//   • WCAG relative luminance / contrast (sRGB)  → accessibility checks.
//   • OKLCH                                       → perceptually-even lightness moves,
//     and it's the space the app's --accent-l/-c/-h component system already speaks.

export type RGB = [number, number, number];
type Family = "dark" | "light";

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x: number) => clamp(x, 0, 1);

// ── Hex ⇄ RGB ──
export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const v = parseInt(n, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export function rgbToHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0")).join("");
}

// ── WCAG contrast (sRGB) ──
const toLinear = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
export function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
/** WCAG contrast ratio in [1, 21]. */
export function contrastRatio(a: RGB, b: RGB): number {
  const l1 = relativeLuminance(a), l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
/** Black or white — whichever reads better on `bg`. The classic accessible foreground. */
export function readableText(bg: RGB): "#ffffff" | "#000000" {
  return contrastRatio([255, 255, 255], bg) >= contrastRatio([0, 0, 0], bg) ? "#ffffff" : "#000000";
}

// ── sRGB ⇄ OKLCH (Björn Ottosson's OKLab) ──
const gammaToLin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const linToGamma = (c: number) => Math.round(clamp01(c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);

/** sRGB [0..255] → [L (0..1), C, H (deg)]. */
export function rgbToOklch([R, G, B]: RGB): [number, number, number] {
  const r = gammaToLin(R), g = gammaToLin(G), b = gammaToLin(B);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  const C = Math.hypot(a, bb);
  let H = (Math.atan2(bb, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}
/** [L, C, H (deg)] → sRGB [0..255], gamut-clamped per channel. */
export function oklchToRgb(L: number, C: number, H: number): RGB {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    linToGamma(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linToGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linToGamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

// ── Derived palette ──────────────────────────────────────────────────────────
export interface Palette {
  accent: { l: number; c: number; h: number };  // OKLCH components → --accent-l/-c/-h
  accentHex: string;                              // accent flattened to sRGB
  onAccent: string;                               // readable foreground ON the accent fill
  complementary: string;                          // accent hue + 180°
  surface1: string;                               // dark/light surface tint (family-aware)
  surface2: string;
  graphEdge: string;                              // complementary, semi-transparent
}

// Representative background luminance per theme family — accent lightness is tuned to
// keep ≥3:1 against this. Approximate (themes vary a little) but with comfortable margin.
const BG_REF: Record<Family, RGB> = { dark: [22, 22, 26], light: [245, 245, 247] };

const ACCENT_MIN_CONTRAST = 3.0;   // WCAG non-text / large-element threshold (icons, bars, fills)
const TEXT_MIN_CONTRAST = 4.5;     // WCAG AA body text (label on the accent button)

/** Pick an OKLCH lightness for (C,H) that clears ACCENT_MIN_CONTRAST against the family bg. */
function fitAccentLightness(C: number, H: number, family: Family): number {
  const bg = BG_REF[family];
  let L = family === "dark" ? 0.68 : 0.55;
  const step = family === "dark" ? 0.03 : -0.03;
  for (let i = 0; i < 24; i++) {
    if (contrastRatio(oklchToRgb(L, C, H), bg) >= ACCENT_MIN_CONTRAST) break;
    L += step;
    if (L > 0.95 || L < 0.4) break;
  }
  return clamp(L, 0.4, 0.95);
}

/**
 * Build the accessible theme palette from an extracted accent + dominant color.
 * `dominant` is optional (older persisted profiles lack it) — falls back to the accent.
 */
export function derivePalette(accentHex: string, dominantHex: string | undefined, family: Family): Palette {
  const accentRgb = hexToRgb(accentHex);
  const [, rawC, rawH] = rgbToOklch(accentRgb);
  // Keep the image's hue; clamp chroma so washed-out images don't go gray and
  // neon images don't blind. Lightness is normalized for UI readability.
  const c = clamp(rawC, 0.05, 0.22);
  const h = rawH;
  const l = fitAccentLightness(c, h, family);

  const finalAccent = oklchToRgb(l, c, h);
  const onAccent = readableText(finalAccent); // guaranteed best of black/white

  const compH = (h + 180) % 360;
  const complementary = rgbToHex(oklchToRgb(l, c, compH));

  // Surfaces: dominant hue, heavily de-chroma'd, lightness set by family.
  const dom = hexToRgb(dominantHex ?? accentHex);
  const [, domC, domH] = rgbToOklch(dom);
  const sc = clamp(domC, 0, 0.035);
  const s1L = family === "dark" ? 0.16 : 0.93;
  const s2L = family === "dark" ? 0.21 : 0.87;
  const surface1 = rgbToHex(oklchToRgb(s1L, sc, domH));
  const surface2 = rgbToHex(oklchToRgb(s2L, sc, domH));

  // Graph edges: complementary, mid lightness, translucent so they stay subtle.
  const ge = oklchToRgb(family === "dark" ? 0.72 : 0.5, Math.min(c, 0.14), compH);
  const graphEdge = `rgba(${ge[0]}, ${ge[1]}, ${ge[2]}, 0.55)`;

  return {
    accent: { l: +l.toFixed(4), c: +c.toFixed(4), h: +h.toFixed(2) },
    accentHex: rgbToHex(finalAccent),
    onAccent,
    complementary,
    surface1,
    surface2,
    graphEdge,
  };
}

// Re-export the contrast threshold so tests assert against the same numbers.
export const CONTRAST = { ACCENT_MIN: ACCENT_MIN_CONTRAST, TEXT_MIN: TEXT_MIN_CONTRAST };
