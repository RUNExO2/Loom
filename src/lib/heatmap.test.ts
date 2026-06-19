import { describe, it, expect } from "vitest";
import { buildHeatmap, toggleLogDate, isLoggedToday } from "./heatmap";

// Fixed "now": Friday 2026-06-19.
const NOW = new Date(2026, 5, 19);

describe("buildHeatmap", () => {
  it("produces whole-week columns covering the window", () => {
    const h = buildHeatmap([], { days: 365, now: NOW });
    // Every column is a full 7-day week.
    expect(h.weeks.every((w) => w.length === 7)).toBe(true);
    // 365 days padded to whole weeks → 53 or 54 columns.
    expect(h.weeks.length).toBeGreaterThanOrEqual(53);
    expect(h.total).toBe(0);
  });

  it("counts completions and totals them", () => {
    const h = buildHeatmap(["2026-06-19", "2026-06-18", "2026-06-18"], { days: 30, now: NOW });
    expect(h.total).toBe(3);
    // The duplicated day has a higher level than the single day.
    const cells = h.weeks.flat().filter((c) => c.inRange && c.count > 0);
    const d18 = cells.find((c) => c.date === "2026-06-18")!;
    const d19 = cells.find((c) => c.date === "2026-06-19")!;
    expect(d18.count).toBe(2);
    expect(d18.level).toBeGreaterThanOrEqual(d19.level);
  });

  it("computes the current streak ending today", () => {
    const h = buildHeatmap(["2026-06-17", "2026-06-18", "2026-06-19"], { now: NOW });
    expect(h.currentStreak).toBe(3);
  });

  it("keeps the streak alive on a not-yet-done today (grace day)", () => {
    // Today (19th) not logged, but the previous three days are.
    const h = buildHeatmap(["2026-06-16", "2026-06-17", "2026-06-18"], { now: NOW });
    expect(h.currentStreak).toBe(3);
  });

  it("breaks the streak after a two-day gap", () => {
    const h = buildHeatmap(["2026-06-15", "2026-06-16"], { now: NOW });
    expect(h.currentStreak).toBe(0);
  });

  it("finds the longest historical streak", () => {
    const h = buildHeatmap(
      ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-10"],
      { now: NOW },
    );
    expect(h.longestStreak).toBe(4);
  });

  it("ignores unparseable / out-of-window dates", () => {
    const h = buildHeatmap(["not-a-date", "1990-01-01"], { days: 30, now: NOW });
    expect(h.total).toBe(0);
  });
});

describe("toggleLogDate / isLoggedToday", () => {
  it("adds a date when absent and removes it when present", () => {
    let log: string[] = [];
    log = toggleLogDate(log, NOW);
    expect(isLoggedToday(log, NOW)).toBe(true);
    log = toggleLogDate(log, NOW);
    expect(isLoggedToday(log, NOW)).toBe(false);
  });
});
