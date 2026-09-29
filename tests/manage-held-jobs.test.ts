import { describe, it, expect } from "vitest";
import {
  describeHeldJob, heldJobNote, heldJobsMessage, supabaseHeldJobsDeps,
  type HeldJobsDeps, type LiveJob,
} from "@/services/manage/held-jobs";
import type { MaintenanceWindow } from "@/services/maintenance/window";

// A site with an update or hardening run already live is skipped (two
// concurrent upgrader passes corrupt a site). The skip used to say "already
// queued / pending from an earlier run" even when that job was held for a
// maintenance window days ahead, which reads like a stuck queue. These
// helpers say *when* it is scheduled, and where to cancel it.

const NOW = new Date("2026-09-29T04:00:00Z");
const MANILA: MaintenanceWindow = { days: [6], start: "01:00", durationMinutes: 120, timeZone: "Asia/Manila" };

function job(over: Partial<LiveJob> = {}): LiveJob {
  return { id: "j1", status: "pending", scheduled_for: "2026-10-02T17:00:00Z", batch_id: "b1", ...over };
}

describe("describeHeldJob", () => {
  it("names the scheduled time in the site's maintenance window zone", () => {
    // 2026-10-02T17:00Z is Sat 3 Oct 01:00 in Manila (UTC+8).
    expect(describeHeldJob(job(), NOW, "Asia/Manila")).toBe("already scheduled for Sat 3 Oct, 01:00 (Asia/Manila)");
  });

  it("falls back to UTC when the site has no window", () => {
    expect(describeHeldJob(job(), NOW, null)).toBe("already scheduled for Fri 2 Oct, 17:00 UTC");
  });

  it("says queued for a pending job that is already due", () => {
    expect(describeHeldJob(job({ scheduled_for: "2026-09-29T03:59:00Z" }), NOW, null)).toBe("already queued");
  });

  it("says running for a running or awaiting-callback job, whatever its schedule", () => {
    expect(describeHeldJob(job({ status: "running" }), NOW, null)).toBe("already running");
    expect(describeHeldJob(job({ status: "awaiting_callback" }), NOW, null)).toBe("already running");
  });

  it("says queued when the job is gone by the time it is looked up", () => {
    expect(describeHeldJob(null, NOW, null)).toBe("already queued");
  });
});

describe("heldJobNote", () => {
  function deps(live: LiveJob | null, window: MaintenanceWindow | null): HeldJobsDeps & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
      calls,
      async liveJob(type, siteId) { calls.push(["liveJob", type, siteId]); return live; },
      async getWindow(siteId) { calls.push(["getWindow", siteId]); return window; },
    };
  }

  it("looks the job up by type and site, and uses the window's zone", async () => {
    const d = deps(job(), MANILA);
    const note = await heldJobNote(d, "update_all_plugins", { id: "s1", name: "Acme" }, NOW);
    expect(d.calls).toContainEqual(["liveJob", "update_all_plugins", "s1"]);
    expect(note).toEqual({
      siteName: "Acme", text: "already scheduled for Sat 3 Oct, 01:00 (Asia/Manila)",
      cancellable: true, batchId: "b1",
    });
  });

  it("does not offer cancelling a running job (only pending ones can be)", async () => {
    const note = await heldJobNote(deps(job({ status: "running" }), null), "harden", { id: "s1", name: "Acme" }, NOW);
    expect(note).toMatchObject({ text: "already running", cancellable: false });
  });
});

describe("heldJobsMessage", () => {
  it("lists each skipped site with when its run is, and where to cancel it", () => {
    const msg = heldJobsMessage([
      { siteName: "Acme", text: "already scheduled for Sat 3 Oct, 01:00 (Asia/Manila)", cancellable: true, batchId: "b1" },
      { siteName: "Beta", text: "already running", cancellable: false, batchId: "b2" },
    ]);
    expect(msg).toContain("Acme already scheduled for Sat 3 Oct, 01:00 (Asia/Manila)");
    expect(msg).toContain("Beta already running");
    expect(msg).toMatch(/cancel .* batch page/i);
    expect(msg).toContain("/marketplace/batches/b1");
    // A running job cannot be cancelled, so its batch is not offered.
    expect(msg).not.toContain("/marketplace/batches/b2");
    expect(msg).not.toMatch(/earlier run/);
  });

  it("offers no cancel hint when nothing is cancellable", () => {
    const msg = heldJobsMessage([{ siteName: "Beta", text: "already running", cancellable: false, batchId: "b2" }]);
    expect(msg).toBe("Beta already running");
  });

  it("caps a long list", () => {
    const notes = Array.from({ length: 6 }, (_, i) => ({
      siteName: `S${i}`, text: "already queued", cancellable: false, batchId: null,
    }));
    const msg = heldJobsMessage(notes);
    expect(msg).toContain("S2 already queued");
    expect(msg).not.toContain("S3");
    expect(msg).toContain("and 3 more");
  });
});

describe("supabaseHeldJobsDeps.liveJob", () => {
  it("uses the same filters as pendingExists and prefers a running job", async () => {
    const filters: unknown[][] = [];
    const rows = [
      { id: "p", status: "pending", scheduled_for: "2026-10-02T17:00:00Z", batch_id: "b1" },
      { id: "r", status: "running", scheduled_for: "2026-09-29T03:00:00Z", batch_id: "b0" },
    ];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "order", "limit"]) {
      q[m] = (...a: unknown[]) => { filters.push([m, ...a]); return q; };
    }
    (q as { then: unknown }).then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
    const db = { from: (t: string) => { filters.push(["from", t]); return q; } };

    const live = await supabaseHeldJobsDeps(db as never).liveJob("harden", "s1");
    expect(live?.id).toBe("r");
    expect(filters).toContainEqual(["from", "jobs"]);
    expect(filters).toContainEqual(["eq", "type", "harden"]);
    expect(filters).toContainEqual(["eq", "site_id", "s1"]);
    expect(filters).toContainEqual(["in", "status", ["pending", "running", "awaiting_callback"]]);
    expect(filters).toContainEqual(["is", "cancelled_at", null]);
  });

  it("returns null when there is none, and throws on a query error", async () => {
    const mk = (result: unknown) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "order", "limit"]) q[m] = () => q;
      (q as { then: unknown }).then = (res: (v: unknown) => unknown) => res(result);
      return { from: () => q } as never;
    };
    expect(await supabaseHeldJobsDeps(mk({ data: [], error: null })).liveJob("harden", "s1")).toBeNull();
    await expect(supabaseHeldJobsDeps(mk({ data: null, error: { message: "boom" } })).liveJob("harden", "s1"))
      .rejects.toThrow(/boom/);
  });
});
