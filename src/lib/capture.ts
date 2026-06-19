// ── Quick Capture routing ────────────────────────────────────────────────────
// One free-text line in, one structured item out. The palette's capture mode pipes
// "Capture: <text>" through detectCapture(); the returned plan is created verbatim
// via the normal ItemStore.create path, so capture is just routing — no special
// write path, no second source of truth.
//
// Detection order (first match wins):
//   1. URL            → bookmark
//   2. task marker    → task        (todo:/task:/- [ ]/remind me to)
//   3. event marker   → calendar    (meeting/call/appointment/standup/…)
//   4. date + time    → calendar    (e.g. "lunch tomorrow at 1pm")
//   5. date only      → task        (actionable with a due date)
//   6. otherwise      → note
//
// extractDate() is the shared NLP date parser (also reused by the task editor),
// returning the matched substring so the title can be cleaned of date noise.

export type CaptureType = "task" | "bookmark" | "note" | "calendar";

export interface CapturePlan {
  type: CaptureType;
  title: string;
  meta: any;
  reason: string;
  icon: string;
  color: string;
}

export interface DateMatch {
  date: Date;
  hasTime: boolean;
  /** The exact substring matched, so callers can strip it from the title. */
  matchText: string;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s]+|[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s]*)?)\b/i;
const TIME_RE = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(?:at\s+)?(\d{1,2}):(\d{2})\b/i;

const TASK_MARKER_RE = /^\s*(?:todo|task)\b[:\-\s]+|^\s*-\s*\[\s?\]\s*|^\s*remind me to\s+/i;
const EVENT_MARKER_RE = /\b(meeting|appointment|standup|stand-up|sync|interview|call with|lunch|dinner|breakfast|coffee|webinar|conference|party|birthday)\b/i;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

// Apply an "HH(:MM) am/pm" or "HH:MM" time onto a base date in place; returns hasTime.
function applyTime(base: Date, src: string): boolean {
  const m = TIME_RE.exec(src);
  if (!m) return false;
  let hh: number;
  let mm = 0;
  if (m[1] !== undefined) {
    hh = parseInt(m[1], 10);
    mm = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = (m[3] || "").toLowerCase();
    if (ampm === "pm" && hh < 12) hh += 12;
    if (ampm === "am" && hh === 12) hh = 0;
  } else {
    hh = parseInt(m[4], 10);
    mm = parseInt(m[5], 10);
  }
  if (hh > 23 || mm > 59) return false;
  base.setHours(hh, mm, 0, 0);
  return true;
}

// Parse the first natural-language date reference out of `text`.
export function extractDate(text: string, now: Date = new Date()): DateMatch | null {
  const lower = text.toLowerCase();
  let date: Date | null = null;
  let matchText = "";

  // Relative day words.
  const rel: [RegExp, number][] = [
    [/\b(today|tonight)\b/i, 0],
    [/\btomorrow\b/i, 1],
    [/\bnext week\b/i, 7],
  ];
  for (const [re, offset] of rel) {
    const m = re.exec(text);
    if (m) {
      date = startOfDay(now);
      date.setDate(date.getDate() + offset);
      matchText = m[0];
      break;
    }
  }

  // Weekday names → next occurrence (today counts only if it's that weekday and future-ish).
  if (!date) {
    for (let i = 0; i < WEEKDAYS.length; i++) {
      const re = new RegExp(`\\b(?:on\\s+)?${WEEKDAYS[i]}\\b`, "i");
      const m = re.exec(lower);
      if (m) {
        date = startOfDay(now);
        let delta = (i - date.getDay() + 7) % 7;
        if (delta === 0) delta = 7; // "monday" said on a Monday means next Monday
        date.setDate(date.getDate() + delta);
        matchText = m[0];
        break;
      }
    }
  }

  // "jun 20" / "june 20" / "20 jun".
  if (!date) {
    const monthName = MONTHS.join("|");
    const re = new RegExp(`\\b(?:(\\d{1,2})\\s+)?(${monthName})[a-z]*\\.?(?:\\s+(\\d{1,2}))?\\b`, "i");
    const m = re.exec(lower);
    if (m && (m[1] || m[3])) {
      const monthIdx = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
      const day = parseInt(m[1] || m[3], 10);
      if (monthIdx >= 0 && day >= 1 && day <= 31) {
        let year = now.getFullYear();
        const candidate = new Date(year, monthIdx, day);
        if (candidate.getTime() < startOfDay(now).getTime()) year += 1; // roll to next year if past
        date = new Date(year, monthIdx, day);
        matchText = m[0];
      }
    }
  }

  // A time with no day reference ("call at 3pm") implies today.
  if (!date) {
    if (TIME_RE.test(text)) {
      date = startOfDay(now);
    } else {
      return null;
    }
  }

  // Layer a time-of-day onto the matched date, if present anywhere in the text.
  const hasTime = applyTime(date, text);
  const timeMatch = hasTime ? (TIME_RE.exec(text)?.[0] ?? "") : "";
  return { date, hasTime, matchText: (matchText + (timeMatch ? " " + timeMatch : "")).trim() };
}

function extractTags(text: string): { tags: string[]; rest: string } {
  const tags: string[] = [];
  const rest = text.replace(/#([a-z0-9_-]+)/gi, (_m, t) => { tags.push(t); return ""; });
  return { tags, rest };
}

function cleanTitle(s: string): string {
  return s.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

function dueLabel(date: Date, now: Date): string {
  const d0 = startOfDay(date).getTime();
  const t0 = startOfDay(now).getTime();
  const days = Math.round((d0 - t0) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1 && days <= 7) return WEEKDAYS[date.getDay()].replace(/^./, (c) => c.toUpperCase());
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function detectCapture(input: string, now: Date = new Date()): CapturePlan {
  const { tags, rest } = extractTags(input);
  const tag = tags[0] || "";
  let text = cleanTitle(rest);

  // 1. URL → bookmark.
  const urlMatch = URL_RE.exec(text);
  if (urlMatch) {
    let url = urlMatch[0];
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const titleText = cleanTitle(text.replace(urlMatch[0], ""));
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep raw */ }
    return {
      type: "bookmark",
      title: titleText || host,
      meta: { url, createdAt: now.toISOString(), tags: tags },
      reason: `Looks like a link → bookmark (${host})`,
      icon: "ph-bookmark-simple", color: "var(--h-bookmarks)",
    };
  }

  const dateInfo = extractDate(text, now);
  const stripDate = (s: string) => dateInfo ? cleanTitle(s.replace(dateInfo.matchText, "")) : s;

  // 2. Explicit task marker → task.
  const taskMarker = TASK_MARKER_RE.exec(text);
  if (taskMarker) {
    const title = stripDate(cleanTitle(text.replace(TASK_MARKER_RE, ""))) || "New task";
    return {
      type: "task",
      title,
      meta: taskMeta(dateInfo, now, tag),
      reason: dateInfo ? `Task due ${dueLabel(dateInfo.date, now)}` : "Marked as a task",
      icon: "ph-check-circle", color: "var(--h-tasks)",
    };
  }

  // 3. Event keyword → calendar.
  const isEvent = EVENT_MARKER_RE.test(text);
  if (isEvent || (dateInfo && dateInfo.hasTime)) {
    const start = dateInfo ? dateInfo.date : new Date(now.getTime() + 3600000);
    const end = new Date(start.getTime() + 3600000);
    const title = stripDate(text) || "New event";
    return {
      type: "calendar",
      title,
      meta: {
        startDate: start.toISOString(), endDate: end.toISOString(),
        allDay: dateInfo ? !dateInfo.hasTime : false,
        description: "", location: "", tags: tag,
        sub: "Event · 1h", color: "var(--h-calendar)",
      },
      reason: dateInfo ? `Event ${dueLabel(start, now)}${dateInfo.hasTime ? " " + start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : ""}` : "Looks like an event",
      icon: "ph-calendar-plus", color: "var(--h-calendar)",
    };
  }

  // 4. Bare date → task with a due date.
  if (dateInfo) {
    const title = stripDate(text) || "New task";
    return {
      type: "task",
      title,
      meta: taskMeta(dateInfo, now, tag),
      reason: `Task due ${dueLabel(dateInfo.date, now)}`,
      icon: "ph-check-circle", color: "var(--h-tasks)",
    };
  }

  // 5. Default → note.
  return {
    type: "note",
    title: text || "Untitled note",
    meta: { preview: "", folder: "Unfiled", updated: "Just now", words: 0, tag, body: [] },
    reason: "Saved as a note",
    icon: "ph-note-pencil", color: "var(--h-notes)",
  };
}

function taskMeta(dateInfo: DateMatch | null, now: Date, tag: string): any {
  return {
    done: false,
    priority: "med",
    dueDate: dateInfo ? isoDate(dateInfo.date) : isoDate(now),
    due: dateInfo ? dueLabel(dateInfo.date, now) : "Today",
    project: "Inbox",
    tag,
    subtasks: [],
  };
}
