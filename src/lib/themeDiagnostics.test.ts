import { describe, it, expect } from "vitest";
import { analyzeTheme, primaryFamily, ThemeProbe } from "./themeDiagnostics";

// A probe with everything healthy; each test overrides just what it breaks.
function probe(over: Partial<ThemeProbe> = {}): ThemeProbe {
  return {
    tokens: {},
    rawVar: () => "#111111",                 // every critical var resolves
    colorVar: () => [255, 255, 255],         // default white; tests override per key
    validColor: () => true,
    fontAvailable: () => true,
    ...over,
  };
}

describe("analyzeTheme", () => {
  it("flags an invalid color override", () => {
    const d = analyzeTheme(probe({ tokens: { "--accent": "notacolor" }, validColor: () => false }));
    expect(d.some((x) => x.category === "Invalid color" && x.message.includes("--accent"))).toBe(true);
  });

  it("flags a missing critical variable", () => {
    const d = analyzeTheme(probe({ rawVar: (k) => (k === "--bg" ? "" : "#111") }));
    const miss = d.find((x) => x.category === "Missing variable");
    expect(miss?.message).toContain("--bg");
    expect(miss?.fix).toBeTruthy();
  });

  it("flags low contrast and reports the ratio + a fix", () => {
    // text and bg both near-black → ~1:1.
    const d = analyzeTheme(probe({ colorVar: () => [10, 10, 10] }));
    const low = d.find((x) => x.category === "Low contrast");
    expect(low).toBeTruthy();
    expect(low!.fix.length).toBeGreaterThan(0);
  });

  it("passes clean when contrast is high and nothing is overridden", () => {
    // Dark surfaces (bg + cards) vs light foregrounds → every pair clears its ratio.
    const d = analyzeTheme(probe({
      colorVar: (k) => (k.includes("bg") || k.includes("surface") ? [10, 10, 12] : [245, 245, 247]),
    }));
    expect(d.filter((x) => x.category === "Low contrast")).toHaveLength(0);
  });

  it("flags an uninstalled font", () => {
    const d = analyzeTheme(probe({ tokens: { "--font-ui": '"Nonesuch Sans", sans-serif' }, fontAvailable: () => false }));
    expect(d.some((x) => x.category === "Invalid font" && x.message.includes("Nonesuch Sans"))).toBe(true);
  });

  it("primaryFamily strips quotes and takes the first family", () => {
    expect(primaryFamily('"Inter", system-ui, sans-serif')).toBe("Inter");
    expect(primaryFamily("Georgia, serif")).toBe("Georgia");
  });
});
