// ── Theme diagnostics ───────────────────────────────────────────────────────────
// Audits the *active* theme (custom-theme overrides + resolved CSS) for problems a
// user can actually fix, and returns one actionable line per issue. Five checks:
//   • Invalid colors     — a color token set to something the browser can't parse.
//   • Low contrast       — a foreground/background pair below its WCAG ratio.
//   • Missing variables  — a critical token that resolves to nothing.
//   • Broken images      — the background image fails to load (moved/deleted).
//   • Invalid fonts      — the chosen UI font isn't installed (silent fallback).
//
// The core (analyzeTheme) is pure: it takes injected probes, so it unit-tests without a
// DOM. The DOM-backed probes (domProbe, fontAvailable, checkBackgroundImage) are below.

import { THEME_SCHEMA } from "./theme";
import { contrastRatio, RGB } from "./palette";

export type Severity = "error" | "warn";
export interface Diagnostic { category: string; severity: Severity; message: string; fix: string; }

// Foreground/background pairs we hold to WCAG. 4.5 = AA body text; 3 = AA large text /
// non-text UI (the accent fill behind icons and bars).
const CONTRAST_CHECKS: { fg: string; bg: string; min: number; label: string }[] = [
  { fg: "--text", bg: "--bg", min: 4.5, label: "Body text on background" },
  { fg: "--text-dim", bg: "--bg", min: 4.5, label: "Secondary text on background" },
  { fg: "--text", bg: "--surface-1", min: 4.5, label: "Text on cards" },
  { fg: "--accent", bg: "--bg", min: 3, label: "Accent on background" },
  { fg: "--reader-text", bg: "--reader-bg", min: 4.5, label: "Reader text on reader background" },
];

const COLOR_KEYS = THEME_SCHEMA.flatMap((g) => g.fields).filter((f) => f.type === "color").map((f) => f.key);

// Without these the UI is unusable, so an empty resolved value is a hard error.
const CRITICAL_VARS = ["--bg", "--text", "--accent", "--surface-1", "--border"];

export interface ThemeProbe {
  tokens: Record<string, string>;          // the active theme's user overrides
  rawVar: (key: string) => string;         // resolved value of a custom property ("" if unset)
  colorVar: (key: string) => RGB | null;   // a token resolved to RGB (oklch/hex/named all OK)
  validColor: (value: string) => boolean;  // does the browser accept this color string?
  fontAvailable: (family: string) => boolean;
}

// First family in a font stack, unquoted: '"Inter", system-ui' → 'Inter'.
export function primaryFamily(stack: string): string {
  const first = stack.split(",")[0]?.trim() ?? "";
  return first.replace(/^['"]|['"]$/g, "").trim();
}

function ratioFix(fg: string, bg: string): string {
  return `Lighten ${fg} or darken ${bg} (or vice-versa) until they clear the ratio. The contrast badge in the colour controls updates live.`;
}

export function analyzeTheme(p: ThemeProbe): Diagnostic[] {
  const out: Diagnostic[] = [];

  // 1. Invalid colors — only the user's own color overrides (the base theme is trusted).
  for (const key of COLOR_KEYS) {
    const v = p.tokens[key];
    if (v == null || v === "") continue;
    if (!p.validColor(v)) {
      out.push({
        category: "Invalid color", severity: "error",
        message: `${key} is set to "${v}", which isn't a valid colour.`,
        fix: `Enter a valid CSS colour for ${key} (e.g. #8b5cf6), or reset it to inherit the base theme.`,
      });
    }
  }

  // 2. Missing variables — a critical token resolving to nothing.
  for (const key of CRITICAL_VARS) {
    if (p.rawVar(key).trim() === "") {
      out.push({
        category: "Missing variable", severity: "error",
        message: `${key} resolves to nothing — elements using it will render unstyled.`,
        fix: `Set ${key} in this theme, or reset overrides so it inherits the base theme value.`,
      });
    }
  }

  // 3. Low contrast.
  for (const c of CONTRAST_CHECKS) {
    const fg = p.colorVar(c.fg), bg = p.colorVar(c.bg);
    if (!fg || !bg) continue; // unparseable values are reported by check #1
    const ratio = contrastRatio(fg, bg);
    if (ratio < c.min) {
      out.push({
        category: "Low contrast", severity: ratio < c.min - 1.5 ? "error" : "warn",
        message: `${c.label} is ${ratio.toFixed(2)}:1 — needs ≥ ${c.min}:1.`,
        fix: ratioFix(c.fg, c.bg),
      });
    }
  }

  // 4. Invalid font.
  const font = p.tokens["--font-ui"];
  if (font) {
    const fam = primaryFamily(font);
    if (fam && !p.fontAvailable(fam)) {
      out.push({
        category: "Invalid font", severity: "warn",
        message: `Font "${fam}" isn't installed — the app is silently falling back to a system font.`,
        fix: `Install "${fam}", or choose an available family in Typography → Font family.`,
      });
    }
  }

  return out;
}

// ── DOM-backed probes ─────────────────────────────────────────────────────────────

// One reusable hidden span. color:var(--x) makes the browser resolve a token (through any
// oklch/var chain) to an rgb() we can read back — far simpler than re-implementing oklch.
function makeColorResolver(): (key: string) => RGB | null {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;opacity:0;pointer-events:none";
  document.body.appendChild(probe);
  return (key: string) => {
    probe.style.color = "rgb(1,2,3)"; // sentinel: if the var is invalid/empty, this stays
    probe.style.color = `var(${key})`;
    const m = getComputedStyle(probe).color.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b] = m[1].split(",").map((n) => parseFloat(n));
    if (r === 1 && g === 2 && b === 3) return null; // var() didn't take → unresolved
    return [r, g, b];
  };
}

// Canonical CSS-color validity test: the browser blanks the property if it rejects the value.
function validColorFn(): (value: string) => boolean {
  const s = document.createElement("span").style;
  return (value: string) => { s.color = ""; s.color = value; return s.color !== ""; };
}

// Classic canvas width test: an unavailable family falls back, matching a base font's
// width across every base. ponytail: false-negative if the font happens to metric-match a
// base font — acceptable for a "did it load" hint, not a precise inventory.
export function fontAvailable(family: string): boolean {
  if (/^(system-ui|sans-serif|serif|monospace|ui-monospace|-apple-system)$/i.test(family.trim())) return true;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return true; // can't measure → don't nag
  const text = "mmmmmmmmmmlli1234567890";
  for (const base of ["monospace", "sans-serif", "serif"]) {
    ctx.font = `72px ${base}`;
    const baseW = ctx.measureText(text).width;
    ctx.font = `72px "${family}", ${base}`;
    if (ctx.measureText(text).width !== baseW) return true;
  }
  return false;
}

// Build a live probe for the running document. `tokens` are the active theme's overrides.
export function domProbe(tokens: Record<string, string>): ThemeProbe {
  const rootStyle = getComputedStyle(document.documentElement);
  return {
    tokens,
    rawVar: (key) => rootStyle.getPropertyValue(key),
    colorVar: makeColorResolver(),
    validColor: validColorFn(),
    fontAvailable,
  };
}

// Async — the background image is the only network/disk asset to verify.
export function checkBackgroundImage(resolvedUrl: string | null | undefined): Promise<Diagnostic | null> {
  return new Promise((resolve) => {
    if (!resolvedUrl) { resolve(null); return; }
    const img = new Image();
    img.onload = () => resolve(null);
    img.onerror = () => resolve({
      category: "Broken image", severity: "error",
      message: "The background image failed to load — the file may have been moved or deleted.",
      fix: "Re-pick the background in the Background System panel, or clear it.",
    });
    img.src = resolvedUrl;
  });
}
