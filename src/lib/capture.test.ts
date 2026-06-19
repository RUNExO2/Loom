import { describe, it, expect } from "vitest";
import { detectCapture, extractDate } from "./capture";

// Fixed "now": Friday 2026-06-19 09:00 local.
const NOW = new Date(2026, 5, 19, 9, 0, 0);

describe("extractDate", () => {
  it("resolves tomorrow", () => {
    const d = extractDate("ship it tomorrow", NOW)!;
    expect(d.date.getDate()).toBe(20);
    expect(d.hasTime).toBe(false);
    expect(d.matchText).toBe("tomorrow");
  });

  it("resolves a weekday to the next occurrence", () => {
    // Friday → "monday" is the coming Monday (June 22).
    const d = extractDate("standup on monday", NOW)!;
    expect(d.date.getDate()).toBe(22);
  });

  it("parses an explicit time of day", () => {
    const d = extractDate("call at 3pm", NOW)!;
    expect(d.hasTime).toBe(true);
    expect(d.date.getHours()).toBe(15);
  });

  it("parses a month-and-day", () => {
    const d = extractDate("renew jun 30", NOW)!;
    expect(d.date.getMonth()).toBe(5);
    expect(d.date.getDate()).toBe(30);
  });

  it("returns null with no date", () => {
    expect(extractDate("just some text", NOW)).toBeNull();
  });
});

describe("detectCapture", () => {
  it("routes a URL to a bookmark", () => {
    const p = detectCapture("read this later https://example.com/post", NOW);
    expect(p.type).toBe("bookmark");
    expect(p.meta.url).toBe("https://example.com/post");
    expect(p.title).toBe("read this later");
  });

  it("upgrades a bare domain to https", () => {
    const p = detectCapture("github.com/anthropics", NOW);
    expect(p.type).toBe("bookmark");
    expect(p.meta.url).toBe("https://github.com/anthropics");
  });

  it("routes an explicit task marker to a task", () => {
    const p = detectCapture("todo: pay rent tomorrow", NOW);
    expect(p.type).toBe("task");
    expect(p.title).toBe("pay rent");
    expect(p.meta.due).toBe("Tomorrow");
  });

  it("routes 'remind me to' to a task", () => {
    const p = detectCapture("remind me to water plants", NOW);
    expect(p.type).toBe("task");
    expect(p.title).toBe("water plants");
  });

  it("routes an event keyword with time to calendar", () => {
    const p = detectCapture("lunch with sam tomorrow at 1pm", NOW);
    expect(p.type).toBe("calendar");
    expect(p.meta.allDay).toBe(false);
    expect(new Date(p.meta.startDate).getHours()).toBe(13);
  });

  it("routes a bare date (no time, no marker) to a task", () => {
    const p = detectCapture("submit report friday", NOW);
    expect(p.type).toBe("task");
    expect(p.meta.dueDate).toBe("2026-06-26");
  });

  it("falls back to a note", () => {
    const p = detectCapture("a fleeting thought about design", NOW);
    expect(p.type).toBe("note");
    expect(p.title).toBe("a fleeting thought about design");
  });

  it("extracts a #tag and removes it from the title", () => {
    const p = detectCapture("idea for the launch #marketing", NOW);
    expect(p.type).toBe("note");
    expect(p.meta.tag).toBe("marketing");
    expect(p.title).toBe("idea for the launch");
  });
});
