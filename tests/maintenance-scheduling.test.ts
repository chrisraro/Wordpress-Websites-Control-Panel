import { describe, expect, it, vi } from "vitest";
import { enqueueBatch } from "@/services/jobs/service";
import { enqueueBulk } from "@/services/bulk/service";
import { planTiming, parseTiming, timingNote } from "@/services/maintenance/schedule";
import type { JobsRepo } from "@/services/jobs/repo";
import type { SitesRepo } from "@/services/sites/repo";
import type { MaintenanceRepo } from "@/services/maintenance/repo";
import type { MaintenanceWindow } from "@/services/maintenance/window";

function fakeJobs() {
  const inserted: Record<string, unknown>[] = [];
  const repo = {
    insert: (job: Record<string, unknown>) => { inserted.push(job); return Promise.resolve({ id: `j${inserted.length}` }); },
  } as unknown as JobsRepo;
  return { repo, inserted };
}

const SAT_1AM: MaintenanceWindow = { days: [6], start: "01:00", durationMinutes: 120, timeZone: "Asia/Manila" };

describe("enqueueBatch scheduledFor", () => {
  it("sets scheduled_for per site from the map and leaves the others to run now", async () => {
    const { repo, inserted } = fakeJobs();
    await enqueueBatch(repo, "update_all_plugins", ["a", "b"], { actor: "u1" }, {
      scheduledFor: new Map([["a", "2026-10-02T17:00:00.000Z"]]),
    });
    expect(inserted[0]).toMatchObject({ site_id: "a", scheduled_for: "2026-10-02T17:00:00.000Z" });
    expect(inserted[1]).toMatchObject({ site_id: "b" });
    expect(inserted[1]).not.toHaveProperty("scheduled_for");
  });

  it("omits scheduled_for entirely when no map is given", async () => {
    const { repo, inserted } = fakeJobs();
    await enqueueBatch(repo, "harden", ["a"], {});
    expect(inserted[0]).not.toHaveProperty("scheduled_for");
  });
});

describe("enqueueBulk scheduledFor", () => {
  it("stamps every item's job with the same scheduled_for", async () => {
    const { repo, inserted } = fakeJobs();
    const sites = { insertActivity: vi.fn().mockResolvedValue(undefined) } as unknown as SitesRepo;
    await enqueueBulk(
      { jobs: repo, sites }, "s1", "u1", "update",
      {
        target: "plugin",
        plugins: [
          { file: "a/a.php", name: "a", version: "1", status: "active", update: "available" },
          { file: "b/b.php", name: "b", version: "1", status: "active", update: "available" },
        ],
      },
      ["a/a.php", "b/b.php"],
      { scheduledFor: "2026-10-02T17:00:00.000Z" },
    );
    expect(inserted).toHaveLength(2);
    for (const job of inserted) expect(job.scheduled_for).toBe("2026-10-02T17:00:00.000Z");
  });
});

describe("parseTiming", () => {
  it("defaults to now for anything but 'window'", () => {
    const fd = new FormData();
    expect(parseTiming(fd)).toBe("now");
    fd.set("timing", "later; drop");
    expect(parseTiming(fd)).toBe("now");
    fd.set("timing", "window");
    expect(parseTiming(fd)).toBe("window");
    expect(parseTiming(undefined)).toBe("now");
  });
});

describe("planTiming", () => {
  const repo = {
    listWindows: vi.fn(async (ids: string[]) =>
      new Map<string, MaintenanceWindow | null>(ids.map((id) => [id, id === "a" ? SAT_1AM : null]))),
  } as unknown as MaintenanceRepo;

  it("does not read windows when running now", async () => {
    const r = await planTiming(repo, ["a"], "now", new Date("2026-09-30T00:00:00Z"));
    expect(r).toEqual({ scheduledFor: new Map(), windowed: 0 });
    expect(repo.listWindows).not.toHaveBeenCalled();
  });

  it("schedules sites with a window and counts them", async () => {
    const r = await planTiming(repo, ["a", "b"], "window", new Date("2026-09-30T00:00:00Z"));
    expect(r.windowed).toBe(1);
    expect(r.scheduledFor.get("a")).toBe("2026-10-02T17:00:00.000Z");
    expect(r.scheduledFor.has("b")).toBe(false);
  });
});

describe("timingNote", () => {
  it("says nothing when everything runs now", () => {
    expect(timingNote(3, 0, "window")).toBe("");
    expect(timingNote(3, 0, "now")).toBe("");
  });

  it("splits windowed and immediate sites", () => {
    expect(timingNote(3, 2, "window")).toBe(" 2 will wait for their maintenance window; 1 runs now.");
    expect(timingNote(2, 2, "window")).toBe(" All will wait for their maintenance window.");
  });
});
