import { describe, it, expect, vi, beforeEach } from "vitest";

// /api/cron/process used to answer ok:true no matter how many jobs failed, so
// the pg_cron caller (and anyone reading its response) could not tell a bad
// run from a good one. ok must reflect failed === 0; counts stay in the body.

vi.mock("@/lib/cron-auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createServiceSupabase: () => ({}) }));
vi.mock("@/services/jobs/repo", () => ({ supabaseJobsRepo: () => ({}) }));
vi.mock("@/services/jobs/handlers", () => ({ buildJobHandlers: () => ({}) }));

const processJobsMock = vi.fn();
vi.mock("@/services/jobs/service", () => ({
  processJobs: (...args: unknown[]) => processJobsMock(...args),
  recoverStaleAwaiting: async () => ({ retried: 0, failed: 0 }),
}));

import { POST } from "@/app/api/cron/process/route";

beforeEach(() => processJobsMock.mockReset());

describe("/api/cron/process", () => {
  it("reports ok:false with counts when any job failed", async () => {
    processJobsMock.mockResolvedValue({ claimed: 3, done: 2, failed: 1, retried: 0, awaiting: 0 });
    const res = await POST(new Request("http://x/api/cron/process", { method: "POST" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: false, claimed: 3, done: 2, failed: 1 });
  });

  it("reports ok:true when nothing failed", async () => {
    processJobsMock.mockResolvedValue({ claimed: 2, done: 2, failed: 0, retried: 0, awaiting: 0 });
    const res = await POST(new Request("http://x/api/cron/process", { method: "POST" }));
    expect(await res.json()).toMatchObject({ ok: true, done: 2, failed: 0 });
  });
});
