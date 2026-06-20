import { describe, it, expect } from "vitest";
import { toEmbedUrl } from "./MediaEmbed";

describe("toEmbedUrl", () => {
  it("converts youtube watch links to embed", () => {
    expect(toEmbedUrl("https://www.youtube.com/watch?v=abc123")).toBe("https://www.youtube.com/embed/abc123");
    expect(toEmbedUrl("https://youtu.be/abc123")).toBe("https://www.youtube.com/embed/abc123");
  });
  it("converts vimeo links to player", () => {
    expect(toEmbedUrl("https://vimeo.com/76979871")).toBe("https://player.vimeo.com/video/76979871");
  });
  it("leaves other urls untouched", () => {
    expect(toEmbedUrl("https://example.com/page")).toBe("https://example.com/page");
    expect(toEmbedUrl("not a url")).toBe("not a url");
  });
});
