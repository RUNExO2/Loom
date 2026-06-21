import { describe, it, expect } from "vitest";
import {
  contrastRatio, relativeLuminance, readableText,
  rgbToOklch, oklchToRgb, hexToRgb, derivePalette, CONTRAST, RGB,
} from "./palette";

describe("palette math", () => {
  it("WCAG contrast extremes", () => {
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 0);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
    expect(relativeLuminance([0, 0, 0])).toBe(0);
  });

  it("readableText picks the higher-contrast foreground", () => {
    expect(readableText([20, 20, 20])).toBe("#ffffff");
    expect(readableText([240, 240, 240])).toBe("#000000");
  });

  it("sRGB ⇄ OKLCH round-trips within tolerance", () => {
    const samples: RGB[] = [[255, 0, 0], [0, 128, 64], [33, 90, 200], [200, 200, 40], [128, 128, 128]];
    for (const c of samples) {
      const [L, C, H] = rgbToOklch(c);
      const back = oklchToRgb(L, C, H);
      for (let i = 0; i < 3; i++) expect(Math.abs(back[i] - c[i])).toBeLessThanOrEqual(2);
    }
  });
});

describe("derivePalette accessibility", () => {
  const DARK_BG: RGB = [22, 22, 26];
  const LIGHT_BG: RGB = [245, 245, 247];
  // A spread of source accents incl. an extreme dark + a near-gray.
  const accents = ["#1a3acc", "#cc2200", "#10b981", "#222222", "#7a7a7a", "#ffe600"];

  for (const family of ["dark", "light"] as const) {
    const bg = family === "dark" ? DARK_BG : LIGHT_BG;
    it(`accent clears ${CONTRAST.ACCENT_MIN}:1 vs ${family} bg`, () => {
      for (const a of accents) {
        const pal = derivePalette(a, "#3a3a40", family);
        expect(contrastRatio(hexToRgb(pal.accentHex), bg)).toBeGreaterThanOrEqual(CONTRAST.ACCENT_MIN - 0.01);
      }
    });

    it(`foreground-on-accent is the best of black/white and ≥ ${CONTRAST.TEXT_MIN}:1`, () => {
      for (const a of accents) {
        const pal = derivePalette(a, undefined, family);
        const acc = hexToRgb(pal.accentHex);
        const got = contrastRatio(hexToRgb(pal.onAccent), acc);
        const other = contrastRatio(pal.onAccent === "#ffffff" ? [0, 0, 0] : [255, 255, 255], acc);
        expect(got).toBeGreaterThanOrEqual(other);          // chose the better foreground
        expect(got).toBeGreaterThanOrEqual(CONTRAST.TEXT_MIN); // and it's readable
      }
    });
  }

  it("complementary hue is ~180° from the accent", () => {
    const pal = derivePalette("#10b981", "#222", "dark");
    const [, , accH] = rgbToOklch(hexToRgb(pal.accentHex));
    const [, , compH] = rgbToOklch(hexToRgb(pal.complementary));
    let sep = Math.abs(accH - compH) % 360;
    if (sep > 180) sep = 360 - sep;
    expect(sep).toBeGreaterThan(172); // ~180° apart (round-trip through sRGB loses a hair)
  });
});
