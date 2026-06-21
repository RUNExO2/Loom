import { describe, it, expect } from "vitest";
import {
  serializeTheme,
  parseTheme,
  composeFilter,
  contrastRatio,
  wcagRating,
  themeToCss,
  randomTheme,
} from "./theme";

describe("Theme Engine Export/Import & Validation", () => {
  it("serializes theme to JSON correctly", () => {
    const theme = {
      id: "test_theme_123",
      name: "Cool Theme",
      blurb: "Blurb",
      tokens: {
        "--bg": "#111111",
        "--accent": "#222222",
      },
    };
    const json = serializeTheme(theme);
    const parsed = JSON.parse(json);
    expect(parsed.loomTheme).toBe(1);
    expect(parsed.name).toBe("Cool Theme");
    expect(parsed.tokens["--bg"]).toBe("#111111");
  });

  it("parses and validates a valid JSON theme", () => {
    const json = JSON.stringify({
      loomTheme: 1,
      name: "Valid Theme",
      tokens: {
        "--bg": "#111111",
        "--accent": "#8b5cf6",
      },
    });
    const parsed = parseTheme(json);
    expect(parsed.name).toBe("Valid Theme");
    expect(parsed.tokens["--bg"]).toBe("#111111");
    expect(parsed.tokens["--accent"]).toBe("#8b5cf6");
  });

  it("throws on invalid JSON string", () => {
    expect(() => parseTheme("{invalid JSON")).toThrow("invalid JSON");
  });

  it("throws on missing loomTheme version marker", () => {
    const json = JSON.stringify({
      name: "No Marker",
      tokens: { "--bg": "#111111" },
    });
    expect(() => parseTheme(json)).toThrow("missing version marker");
  });

  it("throws on missing tokens object", () => {
    const json = JSON.stringify({
      loomTheme: 1,
      name: "No Tokens",
    });
    expect(() => parseTheme(json)).toThrow("missing tokens");
  });

  it("throws on invalid token key", () => {
    const json = JSON.stringify({
      loomTheme: 1,
      name: "Bad Key",
      tokens: {
        "--invalid-key": "#111111",
      },
    });
    expect(() => parseTheme(json)).toThrow("Invalid token key");
  });

  it("throws on CSS injection attempts", () => {
    const jsonInjection1 = JSON.stringify({
      loomTheme: 1,
      name: "Injection 1",
      tokens: {
        "--bg": "#111111; body { background: red; }",
      },
    });
    const jsonInjection2 = JSON.stringify({
      loomTheme: 1,
      name: "Injection 2",
      tokens: {
        "--bg": "#111111 } * { color: red; } {",
      },
    });

    expect(() => parseTheme(jsonInjection1)).toThrow("Invalid characters in token");
    expect(() => parseTheme(jsonInjection2)).toThrow("Invalid characters in token");
  });

  it("sanitizes the theme name correctly", () => {
    const json = JSON.stringify({
      loomTheme: 1,
      name: "My <script>alert('hack')</script> Theme",
      tokens: {
        "--bg": "#111111",
      },
    });
    const parsed = parseTheme(json);
    expect(parsed.name).toBe("My scriptalert('hack')/script Theme");
  });
});

describe("Theme CSS Utilities", () => {
  it("composes filters correctly", () => {
    const tokens = {
      "--ct-blur": "4",
      "--ct-brightness": "1.2",
    };
    const filter = composeFilter(tokens);
    expect(filter).toContain("blur(4px)");
    expect(filter).toContain("brightness(1.2)");
  });

  it("converts theme to CSS variables string correctly", () => {
    const tokens = {
      "--bg": "#111111",
      "--accent": "#222222",
    };
    const css = themeToCss(tokens);
    expect(css).toContain("--bg: #111111;");
    expect(css).toContain("--accent: #222222;");
    expect(css).toContain(":root {");
  });

  it("generates a valid random theme", () => {
    const theme = randomTheme();
    expect(theme.name).toBe("Surprise");
    expect(theme.tokens["--bg"]).toBeDefined();
    expect(theme.tokens["--accent"]).toBeDefined();
  });
});
