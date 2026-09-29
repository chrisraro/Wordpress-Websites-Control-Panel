import { z } from "zod";

/**
 * Per-site maintenance windows (0027_site_maintenance_window.sql).
 *
 * A window is "these weekdays, from this local time, for this long, in this
 * IANA zone". Everything here is pure and timezone-correct without a date
 * library: offsets come from Intl, which carries the zone database the
 * runtime ships with.
 */
export interface MaintenanceWindow {
  /** 0 = Sunday … 6 = Saturday, in the window's own zone. Sorted, unique. */
  days: number[];
  /** Local start time, "HH:MM" (24-hour). */
  start: string;
  durationMinutes: number;
  /** IANA zone, e.g. "Asia/Manila". */
  timeZone: string;
}

export const DEFAULT_TIMEZONE = "Asia/Manila";
export const MIN_DURATION_MINUTES = 15;
/** Twelve hours: a longer "window" is not a window, it is most of the day. */
export const MAX_DURATION_MINUTES = 720;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Look back one day (a window crossing midnight) and ahead a full week. */
const SEARCH_FROM_DAY = -1;
const SEARCH_TO_DAY = 7;

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

function localParts(instantMs: number, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(instantMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year, month: out.month, day: out.day,
    hour: out.hour === 24 ? 0 : out.hour, minute: out.minute, second: out.second,
  };
}

/** Zone offset (local − UTC) in ms at an instant. */
function offsetMs(instantMs: number, timeZone: string): number {
  const p = localParts(instantMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant a local wall-clock time happens in `timeZone`.
 *
 * Ambiguous (fall-back) times resolve to the first occurrence. Times that do
 * not exist (the spring-forward gap) move forward by the size of the gap --
 * 02:30 on a night that jumps 02:00→03:00 runs at 03:30, which is what
 * Temporal calls "compatible" and what a person setting "02:30" would expect.
 */
function zonedToUtc(
  y: number, m: number, d: number, hour: number, minute: number, timeZone: string,
): number {
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const before = offsetMs(wall - DAY_MS / 2, timeZone);
  const after = offsetMs(wall + DAY_MS / 2, timeZone);
  const candidates = [...new Set([wall - before, wall - after])].sort((a, b) => a - b);
  const exact = candidates.filter((c) => {
    const p = localParts(c, timeZone);
    return p.year === y && p.month === m && p.day === d && p.hour === hour && p.minute === minute;
  });
  if (exact.length > 0) return exact[0];
  // In the gap: the pre-transition offset lands after the jump.
  return wall - before;
}

function parseStart(start: string): { hour: number; minute: number } {
  const [h, m] = start.split(":").map(Number);
  return { hour: h, minute: m };
}

/**
 * When work queued `now` should start: `now` itself if a window is open,
 * otherwise the start of the next one. End of a window is exclusive.
 */
export function nextWindowStart(window: MaintenanceWindow, now: Date): Date {
  const nowMs = now.getTime();
  const { hour, minute } = parseStart(window.start);
  const today = localParts(nowMs, window.timeZone);
  let best: number | null = null;

  for (let k = SEARCH_FROM_DAY; k <= SEARCH_TO_DAY; k++) {
    // Calendar arithmetic on a UTC date is zone-free: only Y/M/D and the
    // weekday are read from it.
    const cal = new Date(Date.UTC(today.year, today.month - 1, today.day + k));
    if (!window.days.includes(cal.getUTCDay())) continue;
    const startMs = zonedToUtc(
      cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), hour, minute, window.timeZone,
    );
    const endMs = startMs + window.durationMinutes * MINUTE_MS;
    if (startMs <= nowMs && nowMs < endMs) return now;
    if (startMs > nowMs && (best === null || startMs < best)) best = startMs;
  }
  // Unreachable for a valid window (at least one day in any 8-day span);
  // a malformed one runs now rather than never.
  return best === null ? now : new Date(best);
}

/**
 * Per-site `scheduled_for` for "In each site's maintenance window". Sites
 * with no window, or whose window is open right now, are left out -- the
 * caller enqueues those to run now.
 */
export function scheduleIntoWindows(
  siteIds: string[],
  windows: ReadonlyMap<string, MaintenanceWindow | null>,
  now: Date,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of siteIds) {
    const w = windows.get(id);
    if (!w) continue;
    const start = nextWindowStart(w, now);
    if (start.getTime() > now.getTime()) out.set(id, start.toISOString());
  }
  return out;
}

export interface WindowRow {
  maintenance_days: number[] | null;
  maintenance_start: string | null;
  maintenance_duration_minutes: number | null;
  maintenance_timezone: string | null;
}

export function windowFromRow(row: WindowRow): MaintenanceWindow | null {
  if (!row.maintenance_days?.length || !row.maintenance_start || !row.maintenance_duration_minutes) {
    return null;
  }
  return {
    days: [...new Set(row.maintenance_days)].sort((a, b) => a - b),
    // Postgres `time` reads back as "HH:MM:SS".
    start: row.maintenance_start.slice(0, 5),
    durationMinutes: row.maintenance_duration_minutes,
    timeZone: row.maintenance_timezone || DEFAULT_TIMEZONE,
  };
}

const WindowInput = z.object({
  days: z.array(z.coerce.number().int().min(0).max(6), { error: "Choose valid days of the week." }),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Enter a start time as HH:MM (24-hour)." }),
  duration: z.coerce.number().int()
    .min(MIN_DURATION_MINUTES, { error: `The duration must be at least ${MIN_DURATION_MINUTES} minutes.` })
    .max(MAX_DURATION_MINUTES, { error: `The duration must be at most ${MAX_DURATION_MINUTES / 60} hours.` }),
  timezone: z.string().refine(isValidTimeZone, { error: "That time zone is not recognised." }),
});

export type WindowParse = { ok: true; window: MaintenanceWindow | null } | { ok: false; error: string };

/** No days ticked means "no window"; everything else must be valid. */
export function parseWindowForm(fd: FormData): WindowParse {
  const days = fd.getAll("days").map(String);
  if (days.length === 0) return { ok: true, window: null };
  const parsed = WindowInput.safeParse({
    days,
    start: String(fd.get("start") ?? "").trim(),
    duration: String(fd.get("duration") ?? "").trim(),
    timezone: String(fd.get("timezone") ?? "").trim(),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const msg = issue?.path[0] === "days" ? "Choose valid days of the week." : issue?.message;
    return { ok: false, error: msg ?? "The maintenance window is not valid." };
  }
  return {
    ok: true,
    window: {
      days: [...new Set(parsed.data.days)].sort((a, b) => a - b),
      start: parsed.data.start,
      durationMinutes: parsed.data.duration,
      timeZone: parsed.data.timezone,
    },
  };
}

/** "Sat 3 Oct, 01:00" in the given zone. */
export function formatInZone(date: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}`;
}

/** "Sat 3 Oct, 01:00 (Asia/Manila)", or "Open now" while a window is open. */
export function formatNextWindow(w: MaintenanceWindow, now: Date): string {
  const start = nextWindowStart(w, now);
  if (start.getTime() <= now.getTime()) return "Open now";
  return `${formatInZone(start, w.timeZone)} (${w.timeZone})`;
}

/** "Sun, Sat · 23:00–02:00 (Asia/Manila)". */
export function describeWindow(w: MaintenanceWindow): string {
  const { hour, minute } = parseStart(w.start);
  const endTotal = (hour * 60 + minute + w.durationMinutes) % (24 * 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  const end = `${pad(Math.floor(endTotal / 60))}:${pad(endTotal % 60)}`;
  const days = [...w.days].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d]).join(", ");
  return `${days} · ${w.start}–${end} (${w.timeZone})`;
}
