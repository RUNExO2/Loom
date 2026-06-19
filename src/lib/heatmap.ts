// ── Habit heatmap ─────────────────────────────────────────────────────────────
// GitHub-style contribution grid from a habit's completion log (an array of ISO
// date strings, "YYYY-MM-DD" or any Date-parseable string). Pure and deterministic
// given a fixed `now`, so it unit-tests cleanly and renders identically on every
// machine. Columns are weeks (Sunday→Saturday); the grid is padded out to whole
// weeks at both ends so it always renders as a clean rectangle.

export interface HeatCell {
  date: string; // YYYY-MM-DD
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  /** False for padding cells outside the requested [start, today] window. */
  inRange: boolean;
}

export interface Heatmap {
  weeks: HeatCell[][]; // weeks[col][row], row 0 = Sunday
  total: number;
  currentStreak: number;
  longestStreak: number;
  days: number;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Fold the completion log into a count-per-day map.
function countByDay(completions: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const raw of completions) {
    if (!raw) continue;
    // Accept both bare "YYYY-MM-DD" and full timestamps.
    let key = raw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      const d = new Date(raw);
      if (isNaN(d.getTime())) continue;
      key = keyOf(d);
    }
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
}

function levelFor(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (max <= 1) return 4;
  const r = count / max;
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}

export function buildHeatmap(
  completions: string[],
  opts: { days?: number; now?: Date } = {},
): Heatmap {
  const days = opts.days ?? 365;
  const today = startOfDay(opts.now ?? new Date());
  const start = addDays(today, -(days - 1));
  const counts = countByDay(completions);
  const max = Math.max(1, ...Array.from(counts.values()));

  // Pad to whole weeks: grid starts on the Sunday on/before `start`, ends on the
  // Saturday on/after `today`.
  const gridStart = addDays(start, -start.getDay());
  const gridEnd = addDays(today, 6 - today.getDay());

  const weeks: HeatCell[][] = [];
  let col: HeatCell[] = [];
  let total = 0;
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) {
    const key = keyOf(d);
    const inRange = d >= start && d <= today;
    const count = inRange ? counts.get(key) || 0 : 0;
    if (inRange) total += count;
    col.push({ date: key, count, level: levelFor(count, max), inRange });
    if (col.length === 7) {
      weeks.push(col);
      col = [];
    }
  }
  if (col.length) {
    while (col.length < 7) col.push({ date: "", count: 0, level: 0, inRange: false });
    weeks.push(col);
  }

  return {
    weeks,
    total,
    currentStreak: currentStreak(counts, today),
    longestStreak: longestStreak(counts, start, today),
    days,
  };
}

// Consecutive completed days ending at today — or yesterday, if today isn't done yet
// (a one-day grace so an in-progress day doesn't read as a broken streak).
function currentStreak(counts: Map<string, number>, today: Date): number {
  let anchor = today;
  if (!(counts.get(keyOf(today)) || 0)) {
    const y = addDays(today, -1);
    if (!(counts.get(keyOf(y)) || 0)) return 0;
    anchor = y;
  }
  let streak = 0;
  for (let d = anchor; counts.get(keyOf(d)) || 0; d = addDays(d, -1)) streak++;
  return streak;
}

// Longest run of consecutive completed days anywhere in [start, today].
function longestStreak(counts: Map<string, number>, start: Date, today: Date): number {
  let best = 0;
  let run = 0;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (counts.get(keyOf(d)) || 0) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

// Toggle a date in a completion log (used by the habit check-in). Returns a new
// array so callers can persist it directly into metadata.
export function toggleLogDate(log: string[], date: Date = new Date()): string[] {
  const key = keyOf(date);
  const has = log.some((d) => d.slice(0, 10) === key);
  return has ? log.filter((d) => d.slice(0, 10) !== key) : [...log, key];
}

export function isLoggedToday(log: string[], now: Date = new Date()): boolean {
  const key = keyOf(now);
  return log.some((d) => d.slice(0, 10) === key);
}
