// ── Recurrence parsing ────────────────────────────────────────────────────────
// Turns a free-text recurrence phrase into the {unit, every} contract the Rust
// scheduler reads from task metadata (see automation.rs recurring_tick). Pure and
// dependency-free so it unit-tests cleanly and is reused by the task editor and
// quick-capture.

export type RecurrenceUnit = "day" | "week" | "month" | "year";

export interface Recurrence {
  unit: RecurrenceUnit;
  every: number;
}

const NAMED: Record<string, Recurrence> = {
  daily: { unit: "day", every: 1 },
  weekly: { unit: "week", every: 1 },
  biweekly: { unit: "week", every: 2 },
  fortnightly: { unit: "week", every: 2 },
  monthly: { unit: "month", every: 1 },
  quarterly: { unit: "month", every: 3 },
  yearly: { unit: "year", every: 1 },
  annually: { unit: "year", every: 1 },
};

const UNIT_WORDS: Record<string, RecurrenceUnit> = {
  day: "day", days: "day", daily: "day",
  week: "week", weeks: "week", weekly: "week",
  month: "month", months: "month", monthly: "month",
  year: "year", years: "year", yearly: "year",
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseRecurrence(input: string): Recurrence | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  if (NAMED[text]) return NAMED[text];

  // "every weekday-name" → weekly.
  for (const wd of WEEKDAYS) {
    if (text === `every ${wd}` || text === wd + "s") return { unit: "week", every: 1 };
  }

  // "every [N] <unit>"  ·  "every other <unit>"  ·  "<unit>ly"
  const m = text.match(/^(?:every\s+)?(\d+|other)?\s*(day|days|daily|week|weeks|weekly|month|months|monthly|year|years|yearly)$/);
  if (m) {
    const unit = UNIT_WORDS[m[2]];
    if (!unit) return null;
    let every = 1;
    if (m[1] === "other") every = 2;
    else if (m[1]) every = Math.max(1, parseInt(m[1], 10));
    return { unit, every };
  }
  return null;
}

export function recurrenceLabel(r: Recurrence | null | undefined): string {
  if (!r) return "Does not repeat";
  const { unit, every } = r;
  if (every === 1) {
    return { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[unit];
  }
  if (every === 2 && unit === "week") return "Every 2 weeks";
  return `Every ${every} ${unit}s`;
}
