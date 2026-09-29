import { describe, it, expect, vi, beforeEach } from "vitest";
import { isSeoScanDue } from "@/services/seo/schedule";

// Two nightly-fan-out bugs in /api/cron/enqueue:
//  1. Promise.all over sites: one site's enqueue error rejected the whole run,
//     so every other site silently missed its nightly snapshot/scan.
//  2. Weekly SEO drifted to ~8 days: lastRunAt is when the scan *finished*
//     (after the enqueue that night), compared against a strict 7-day cutoff
//     at the next night's enqueue time -- 7 days later it is a few minutes
//     short of 7 days, so it waited another night.

vi.mock("@/lib/cron-auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createServiceSupabase: () => ({}) }));
vi.mock("@/services/jobs/repo", () => ({ supabaseJobsRepo: () => ({}) }));
vi.mock("@/services/reports/repo", () => ({ supabaseReportsRepo: () => ({ autoExistsSince: async () => true }) }));

const listSites = vi.fn();
vi.mock("@/services/sites/repo", () => ({ supabaseSitesRepo: () => ({ listSites }) }));
const lastRunAt = vi.fn();
vi.mock("@/services/seo/repo", () => ({ supabaseSeoRepo: () => ({ lastRunAt }) }));
const enqueueJob = vi.fn();
vi.mock("@/services/jobs/service", () => ({ enqueueJob: (...a: unknown[]) => enqueueJob(...a) }));

import { POST } from "@/app/api/cron/enqueue/route";

const DAY = 86_400_000;

beforeEach(() => {
  listSites.mockReset();
  lastRunAt.mockReset();
  enqueueJob.mockReset();
});

describe("isSeoScanDue", () => {
  const now = Date.UTC(2026, 8, 29, 2, 0, 0);
  it("is due with no previous run", () => {
    expect(isSeoScanDue(null, now)).toBe(true);
  });
  it("is due when last week's scan finished minutes after last week's enqueue", () => {
    // Enqueued 02:00 a week ago, completed 02:07: 6 days 23h53m before now.
    const finished = new Date(now - 7 * DAY + 7 * 60_000).toISOString();
    expect(isSeoScanDue(finished, now)).toBe(true);
  });
  it("is not due a few days after a run", () => {
    expect(isSeoScanDue(new Date(now - 3 * DAY).toISOString(), now)).toBe(false);
    expect(isSeoScanDue(new Date(now - 6 * DAY).toISOString(), now)).toBe(false);
  });
});

describe("/api/cron/enqueue", () => {
  it("keeps enqueuing other sites when one site fails, and names the failure", async () => {
    listSites.mockResolvedValue([
      { id: "a", status: "connected" }, { id: "b", status: "connected" }, { id: "c", status: "connected" },
    ]);
    lastRunAt.mockResolvedValue(new Date().toISOString());
    enqueueJob.mockImplementation(async (_repo: unknown, type: string, siteId: string | null) => {
      if (siteId === "b" && type === "snapshot_refresh") throw new Error("db hiccup");
      return { id: `${type}-${siteId}` };
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await POST(new Request("http://x/api/cron/enqueue", { method: "POST" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, enqueued: 2, scans: 2, failed: 1, failed_sites: ["b"] });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("reports ok with no failures", async () => {
    listSites.mockResolvedValue([{ id: "a", status: "connected" }]);
    lastRunAt.mockResolvedValue(null);
    enqueueJob.mockImplementation(async (_r: unknown, type: string, siteId: string | null) => ({ id: `${type}-${siteId}` }));
    const body = await (await POST(new Request("http://x/api/cron/enqueue", { method: "POST" }))).json();
    expect(body).toMatchObject({ ok: true, enqueued: 1, scans: 1, seo: 1, failed: 0, failed_sites: [] });
  });
});
