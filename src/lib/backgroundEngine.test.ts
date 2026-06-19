import { describe, it, expect, vi } from "vitest";
import { processBackground } from "./backgroundEngine";
import { applyBackgroundConfig } from "./settings";
import { applyCustomTheme } from "./theme";

describe("Background Engine Core", () => {
  it("extracts colors and variance correctly using processBackground", async () => {
    // Mock the global Image
    const originalImage = global.Image;
    
    const mockImageInstance = {
      onload: null as any,
      onerror: null as any,
      width: 100,
      height: 100,
      set src(_value: string) {
        // Trigger onload asynchronously
        setTimeout(() => {
          if (this.onload) this.onload();
        }, 10);
      }
    };
    
    global.Image = function() {
      return mockImageInstance;
    } as any;

    // Mock HTMLCanvasElement and 2d context
    const originalCreateElement = document.createElement;
    const mockContext = {
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        width: 100,
        height: 100,
        data: new Uint8ClampedArray(40000).fill(128) // neutral gray image
      })
    };
    
    document.createElement = vi.fn().mockImplementation((tag) => {
      if (tag === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue(mockContext)
        };
      }
      return originalCreateElement.call(document, tag);
    }) as any;

    // Process a dummy image URL
    const result = await processBackground("data:image/png;base64,dummy");

    expect(result).toBeDefined();
    expect(result.colors).toBeDefined();
    expect(result.colors.primary).toBe("#808080"); // since whole image is gray (128, 128, 128) -> #808080
    expect(result.luminance).toBeCloseTo(0.50196, 4); // 0.299*128 + 0.587*128 + 0.114*128 = 128 / 255 = 0.50196

    // Restore original globals
    global.Image = originalImage;
    document.createElement = originalCreateElement;
  });

  it("handles high luminance image with stronger card overlay opacity", async () => {
    const originalImage = global.Image;
    
    const mockImageInstance = {
      onload: null as any,
      onerror: null as any,
      width: 10,
      height: 10,
      set src(_value: string) {
        setTimeout(() => {
          if (this.onload) this.onload();
        }, 10);
      }
    };
    
    global.Image = function() {
      return mockImageInstance;
    } as any;

    const originalCreateElement = document.createElement;
    const mockContext = {
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        width: 10,
        height: 10,
        data: new Uint8ClampedArray(400).fill(250) // bright white-ish image (250, 250, 250)
      })
    };
    
    document.createElement = vi.fn().mockImplementation((tag) => {
      if (tag === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue(mockContext)
        };
      }
      return originalCreateElement.call(document, tag);
    }) as any;

    const result = await processBackground("data:image/png;base64,dummy");

    expect(result.luminance).toBeGreaterThan(0.9);
    // For avgLuminance > 0.6, overlayOpacity should be 0.85
    // --region-overlay-card should use Math.round(0.85 * 100) = 85%
    expect(result.cssVars["--region-overlay-card"]).toContain("85%");

    global.Image = originalImage;
    document.createElement = originalCreateElement;
  });

  it("applyBackgroundConfig: cleans up style variables when bgUseColors is false or bgImage is missing", () => {
    // Pre-populate style values
    document.documentElement.style.setProperty("--accent", "#ff0000");
    document.documentElement.style.setProperty("--selection-bg", "#ff0000");
    document.documentElement.style.setProperty("--surface-1", "#121212");

    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#ff0000");

    // 1. Call with bgUseColors: false
    applyBackgroundConfig({
      bgImage: "test.jpg",
      bgDynamic: true,
      bgUseColors: false,
      bgParallax: true,
      profile: {
        cssVars: {},
        colors: { primary: "#00ff00", secondary: "#0000ff", surfaceTint: "#232323" },
        luminance: 0.5
      }
    });

    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--selection-bg")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--surface-1")).toBe("");

    // Pre-populate again
    document.documentElement.style.setProperty("--accent", "#ff0000");

    // 2. Call with bgImage: null
    applyBackgroundConfig({
      bgImage: null,
      bgDynamic: true,
      bgUseColors: true,
      bgParallax: true,
      profile: null
    });

    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });

  it("coerces background config and custom theme correctly", () => {
    // 1. Clear any state first
    applyCustomTheme(null, false);
    applyBackgroundConfig({
      bgImage: null,
      bgDynamic: true,
      bgUseColors: false,
      bgParallax: true,
      profile: null
    });

    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");

    // 2. Custom theme is enabled, background extraction is enabled
    applyCustomTheme({
      id: "ct_test",
      name: "Test theme",
      tokens: { "--accent": "#999999" }
    }, true);

    applyBackgroundConfig({
      bgImage: "test.jpg",
      bgDynamic: true,
      bgUseColors: true,
      bgParallax: true,
      profile: {
        cssVars: {},
        colors: { primary: "#00ff00", secondary: "#0000ff", surfaceTint: "#232323" },
        luminance: 0.5
      }
    });

    // Custom theme token should take precedence over background extracted color
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#999999");
    // Background colors should apply to selection-bg and surface-1 as they are not overridden
    expect(document.documentElement.style.getPropertyValue("--selection-bg")).toBe("#00ff00");
    expect(document.documentElement.style.getPropertyValue("--surface-1")).toBe("#232323");

    // 3. Toggle background extraction to false
    applyBackgroundConfig({
      bgImage: "test.jpg",
      bgDynamic: true,
      bgUseColors: false,
      bgParallax: true,
      profile: {
        cssVars: {},
        colors: { primary: "#00ff00", secondary: "#0000ff", surfaceTint: "#232323" },
        luminance: 0.5
      }
    });

    // Custom theme token is preserved
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#999999");
    // Background extracted colors are removed
    expect(document.documentElement.style.getPropertyValue("--selection-bg")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--surface-1")).toBe("");

    // 4. Disable custom theme
    applyCustomTheme(null, false);

    // Everything is cleared
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--selection-bg")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--surface-1")).toBe("");
  });
});
