import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeWindow, formatInZone, formatNextWindow, nextWindowStart, parseWindowForm, scheduleIntoWindows,
  windowFromRow, type MaintenanceWindow,
} from "@/services/maintenance/window";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0027_site_maintenance_window.sql"),
  "utf8",
);

const SAT = 6;
const SUN = 0;
const WED = 3;

function manila(days: number[], start: string, durationMinutes: number): MaintenanceWindow {
  return { days, start, durationMinutes, timeZone: "Asia/Manila" };
}

const iso = (d: Date) => d.toISOString();

describe("nextWindowStart — Asia/Manila (UTC+8, no DST)", () => {
  const sat1am = manila([SAT], "01:00", 120);

  it("returns the next start when now is before it", () => {
    // Wed 30 Sep 2026 08:00 Manila.
    const now = new Date("2026-09-30T00:00:00Z");
    // Sat 3 Oct 01:00 Manila = Fri 2 Oct 17:00 UTC.
    expect(iso(nextWindowStart(sat1am, now))).toBe("2026-10-02T17:00:00.000Z");
  });

  it("returns now when now is inside the window", () => {
    const now = new Date("2026-10-02T17:30:00Z");
    expect(nextWindowStart(sat1am, now)).toEqual(now);
  });

  it("returns now at the exact start of the window", () => {
    const now = new Date("2026-10-02T17:00:00Z");
    expect(nextWindowStart(sat1am, now)).toEqual(now);
  });

  it("rolls to next week once the window has closed (end is exclusive)", () => {
    const now = new Date("2026-10-02T19:00:00Z");
    expect(iso(nextWindowStart(sat1am, now))).toBe("2026-10-09T17:00:00.000Z");
  });

  it("picks the earliest of several days", () => {
    const w = manila([SAT, WED], "02:00", 60);
    // Tue 29 Sep 2026 12:00 Manila -> Wed 30 Sep 02:00 Manila = Tue 29 18:00 UTC.
    const now = new Date("2026-09-29T04:00:00Z");
    expect(iso(nextWindowStart(w, now))).toBe("2026-09-29T18:00:00.000Z");
  });

  it("finds a window later the same local day", () => {
    const w = manila([WED], "22:00", 60);
    // Wed 30 Sep 10:00 Manila.
    const now = new Date("2026-09-30T02:00:00Z");
    expect(iso(nextWindowStart(w, now))).toBe("2026-09-30T14:00:00.000Z");
  });

  it("treats a window that crosses midnight as open on the following morning", () => {
    const w = manila([SAT], "23:00", 180);
    // Sun 4 Oct 00:30 Manila -- inside Saturday's 23:00-02:00 window.
    const now = new Date("2026-10-03T16:30:00Z");
    expect(nextWindowStart(w, now)).toEqual(now);
  });

  it("uses the local weekday, not the UTC one", () => {
    // Sat 3 Oct 2026 07:00 Manila is still Fri 2 Oct in UTC.
    const w = manila([SAT], "09:00", 60);
    const now = new Date("2026-10-02T23:00:00Z");
    expect(iso(nextWindowStart(w, now))).toBe("2026-10-03T01:00:00.000Z");
  });
});

describe("nextWindowStart — America/New_York (DST)", () => {
  const daily3am = { days: [0, 1, 2, 3, 4, 5, 6], start: "03:00", durationMinutes: 60, timeZone: "America/New_York" };

  it("uses EST after the November fall-back", () => {
    // Sat 31 Oct 2026 08:00 EDT. Next 03:00 is Sun 1 Nov, after the 02:00 fall-back: EST (UTC-5).
    const now = new Date("2026-10-31T12:00:00Z");
    expect(iso(nextWindowStart(daily3am, now))).toBe("2026-11-01T08:00:00.000Z");
  });

  it("uses EDT after the March spring-forward", () => {
    // Sat 7 Mar 2026 07:00 EST. Next 03:00 is Sun 8 Mar, after the jump: EDT (UTC-4).
    const now = new Date("2026-03-07T12:00:00Z");
    expect(iso(nextWindowStart(daily3am, now))).toBe("2026-03-08T07:00:00.000Z");
  });

  it("moves a start inside the spring-forward gap to just after it", () => {
    // 02:30 does not exist on 8 Mar 2026 in New York; it runs at 03:30 EDT.
    const w = { days: [SUN], start: "02:30", durationMinutes: 60, timeZone: "America/New_York" };
    const now = new Date("2026-03-07T12:00:00Z");
    expect(iso(nextWindowStart(w, now))).toBe("2026-03-08T07:30:00.000Z");
  });

  it("uses the first occurrence of an ambiguous fall-back time", () => {
    // 01:30 happens twice on 1 Nov 2026; the first is EDT (05:30 UTC).
    const w = { days: [SUN], start: "01:30", durationMinutes: 30, timeZone: "America/New_York" };
    const now = new Date("2026-10-31T12:00:00Z");
    expect(iso(nextWindowStart(w, now))).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("scheduleIntoWindows", () => {
  it("schedules sites with a window and leaves the rest to run now", () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const out = scheduleIntoWindows(
      ["a", "b", "c"],
      new Map<string, MaintenanceWindow | null>([["a", manila([SAT], "01:00", 120)], ["b", null]]),
      now,
    );
    expect(out.get("a")).toBe("2026-10-02T17:00:00.000Z");
    expect(out.has("b")).toBe(false);
    expect(out.has("c")).toBe(false);
  });

  it("leaves a site whose window is open right now to run now", () => {
    const now = new Date("2026-10-02T17:30:00Z");
    const out = scheduleIntoWindows(["a"], new Map([["a", manila([SAT], "01:00", 120)]]), now);
    expect(out.has("a")).toBe(false);
  });
});

describe("windowFromRow", () => {
  it("reads a Postgres time with seconds", () => {
    expect(windowFromRow({
      maintenance_days: [6], maintenance_start: "01:00:00",
      maintenance_duration_minutes: 120, maintenance_timezone: "Asia/Manila",
    })).toEqual(manila([6], "01:00", 120));
  });

  it("returns null when no window is set", () => {
    expect(windowFromRow({
      maintenance_days: null, maintenance_start: null,
      maintenance_duration_minutes: null, maintenance_timezone: "Asia/Manila",
    })).toBeNull();
  });
});

describe("parseWindowForm", () => {
  function fd(entries: [string, string][]): FormData {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  }

  it("parses a valid window", () => {
    const r = parseWindowForm(fd([
      ["days", "6"], ["days", "0"], ["start", "01:00"], ["duration", "120"], ["timezone", "Asia/Manila"],
    ]));
    expect(r).toEqual({ ok: true, window: { days: [0, 6], start: "01:00", durationMinutes: 120, timeZone: "Asia/Manila" } });
  });

  it("treats no days as clearing the window", () => {
    expect(parseWindowForm(fd([["start", "01:00"], ["duration", "120"], ["timezone", "Asia/Manila"]])))
      .toEqual({ ok: true, window: null });
  });

  it.each<[[string, string][], RegExp]>([
    [[["days", "7"], ["start", "01:00"], ["duration", "60"], ["timezone", "Asia/Manila"]], /day/i],
    [[["days", "1"], ["start", "25:00"], ["duration", "60"], ["timezone", "Asia/Manila"]], /start time/i],
    [[["days", "1"], ["start", "01:00"], ["duration", "5"], ["timezone", "Asia/Manila"]], /duration/i],
    [[["days", "1"], ["start", "01:00"], ["duration", "60"], ["timezone", "Mars/Olympus"]], /time zone/i],
  ])("rejects invalid input %#", (entries, message) => {
    const r = parseWindowForm(fd(entries));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });
});

describe("formatting", () => {
  it("formats an instant in the window's zone", () => {
    expect(formatInZone(new Date("2026-10-02T17:00:00Z"), "Asia/Manila")).toBe("Sat 3 Oct, 01:00");
  });

  it("labels the next window, or says it is open now", () => {
    const w = manila([SAT], "01:00", 120);
    expect(formatNextWindow(w, new Date("2026-09-30T00:00:00Z"))).toBe("Sat 3 Oct, 01:00 (Asia/Manila)");
    expect(formatNextWindow(w, new Date("2026-10-02T17:30:00Z"))).toBe("Open now");
  });

  it("describes a window in words", () => {
    expect(describeWindow(manila([SAT, SUN], "23:00", 180))).toBe("Sun, Sat · 23:00–02:00 (Asia/Manila)");
  });
});

describe("0027_site_maintenance_window.sql", () => {
  it("adds the four columns re-runnably, with Manila as the default zone", () => {
    expect(MIGRATION).toMatch(/add column if not exists maintenance_days int\[\]/);
    expect(MIGRATION).toMatch(/add column if not exists maintenance_start time/);
    expect(MIGRATION).toMatch(/add column if not exists maintenance_duration_minutes int/);
    expect(MIGRATION).toMatch(/maintenance_timezone text not null default 'Asia\/Manila'/);
    expect(MIGRATION).toMatch(/drop constraint if exists sites_maintenance_window_complete/);
  });

  it("requires all or none of the window fields and bounds the days", () => {
    expect(MIGRATION).toContain("sites_maintenance_window_complete");
    expect(MIGRATION).toContain("<@ array[0,1,2,3,4,5,6]");
  });

  it("never grants the columns to the client role", () => {
    expect(MIGRATION).not.toMatch(/grant\s+select/i);
  });
});
