import { describe, it, expect } from "vitest";
import { parseRecurrence, recurrenceLabel } from "./recurrence";

describe("parseRecurrence", () => {
  it("parses named intervals", () => {
    expect(parseRecurrence("daily")).toEqual({ unit: "day", every: 1 });
    expect(parseRecurrence("weekly")).toEqual({ unit: "week", every: 1 });
    expect(parseRecurrence("monthly")).toEqual({ unit: "month", every: 1 });
    expect(parseRecurrence("yearly")).toEqual({ unit: "year", every: 1 });
    expect(parseRecurrence("biweekly")).toEqual({ unit: "week", every: 2 });
  });

  it("parses 'every N <unit>'", () => {
    expect(parseRecurrence("every 2 weeks")).toEqual({ unit: "week", every: 2 });
    expect(parseRecurrence("every 3 days")).toEqual({ unit: "day", every: 3 });
    expect(parseRecurrence("every 6 months")).toEqual({ unit: "month", every: 6 });
  });

  it("parses 'every other <unit>' as 2", () => {
    expect(parseRecurrence("every other day")).toEqual({ unit: "day", every: 2 });
  });

  it("parses bare 'every <unit>' as 1", () => {
    expect(parseRecurrence("every week")).toEqual({ unit: "week", every: 1 });
  });

  it("treats a weekday as weekly", () => {
    expect(parseRecurrence("every monday")).toEqual({ unit: "week", every: 1 });
  });

  it("returns null for non-recurrence text", () => {
    expect(parseRecurrence("")).toBeNull();
    expect(parseRecurrence("sometime soon")).toBeNull();
  });
});

describe("recurrenceLabel", () => {
  it("labels common cases", () => {
    expect(recurrenceLabel(null)).toBe("Does not repeat");
    expect(recurrenceLabel({ unit: "day", every: 1 })).toBe("Daily");
    expect(recurrenceLabel({ unit: "week", every: 2 })).toBe("Every 2 weeks");
    expect(recurrenceLabel({ unit: "month", every: 3 })).toBe("Every 3 months");
  });
});
