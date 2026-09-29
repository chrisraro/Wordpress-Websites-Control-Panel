import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * claim_jobs runs in Postgres, out of reach of the unit suite, so pin the
 * predicates that keep the queue from looping or double-running a site.
 */
const SQL = readFileSync(
  new URL("../supabase/migrations/0022_claim_jobs_hardening.sql", import.meta.url), "utf8",
).replace(/--.*$/gm, "").replace(/\s+/g, " ");

describe("0022 claim_jobs hardening", () => {
  it("fails a stale running job that has spent its attempts instead of reclaiming it", () => {
    expect(SQL).toMatch(/set status = 'failed'.*where status = 'running' and started_at < now\(\) - interval '15 minutes' and attempts >= 3/);
  });

  it("reclaims a stale running job only while it has attempts left", () => {
    expect(SQL).toMatch(/j\.status = 'running' and j\.started_at < now\(\) - interval '15 minutes' and j\.attempts < 3/);
  });

  it("does not claim a pending job while the same site has a live running job", () => {
    expect(SQL).toMatch(/not exists \( select 1 from jobs r where r\.site_id = j\.site_id and r\.status = 'running'/);
  });

  it("keeps the cancelled guard, SKIP LOCKED and the service-role-only grant", () => {
    expect(SQL).toContain("j.cancelled_at is null");
    expect(SQL).toContain("for update skip locked");
    expect(SQL).toContain("revoke execute on function claim_jobs(int) from public, anon, authenticated");
  });
});
