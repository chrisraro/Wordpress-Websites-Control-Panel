import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow, JobType } from "@/services/jobs/types";
import { buildJobHandlers } from "@/services/jobs/handlers";

const securityScanMock = vi.fn((..._args: unknown[]) => Promise.resolve({ grade: "A", vulnCount: 0 }));
const generateReportMock = vi.fn((..._args: unknown[]) => Promise.resolve({ id: "r1" }));

vi.mock("@/services/security/scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/security/scan")>();
  return { ...actual, securityScan: (...args: unknown[]) => securityScanMock(...args) };
});
vi.mock("@/services/reports/generate", () => ({
  generateReport: (...args: unknown[]) => generateReportMock(...args),
}));

const db = {
  from() { throw new Error("not used"); },
  storage: { from() { throw new Error("not used"); } },
} as unknown as SupabaseClient;

function job(type: JobType, payload: Record<string, unknown>, attempts: number): JobRow {
  return {
    id: "j1", type, site_id: "site-1", batch_id: null, payload, status: "running", attempts,
    scheduled_for: new Date(0).toISOString(), last_error: null, dismissed_at: null, finished_at: null,
  };
}

beforeEach(() => { securityScanMock.mockClear(); generateReportMock.mockClear(); });

describe("security_scan handler counts only the final attempt toward 'degraded'", () => {
  it.each([[1, false], [2, false], [3, true]])("attempt %i → recordFailure %s", async (attempts, expected) => {
    await buildJobHandlers(db).security_scan!({ job: job("security_scan", {}, attempts) });
    expect(securityScanMock.mock.calls[0][2]).toEqual({ recordFailure: expected });
  });
});

describe("report_generate handler: monthly vs asked-for", () => {
  it("marks a monthly (unmarked) report auto, so it gets no share link", async () => {
    await buildJobHandlers(db).report_generate!({ job: job("report_generate", { period_days: 30 }, 1) });
    expect(generateReportMock.mock.calls[0][4]).toBe(true);
  });

  it("gives a manually queued report a share link (auto false)", async () => {
    await buildJobHandlers(db).report_generate!({
      job: job("report_generate", { period_days: 30, manual: true }, 1),
    });
    expect(generateReportMock.mock.calls[0][4]).toBe(false);
  });
});
