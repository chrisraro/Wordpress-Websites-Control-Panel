import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/** prune_history deletes data irreversibly; pin the approved windows. */
const SQL = readFileSync(
  new URL("../supabase/migrations/0025_history_retention.sql", import.meta.url), "utf8",
).replace(/--.*$/gm, "").replace(/\s+/g, " ");

describe("0025 history retention", () => {
  it.each([
    ["uptime_checks", "checked_at < now() - interval '90 days'"],
    ["jobs", "finished_at < now() - interval '60 days'"],
    ["site_snapshots", "taken_at < now() - interval '180 days'"],
    ["security_checks", "run_at < now() - interval '365 days'"],
    ["seo_snapshots", "taken_at < now() - interval '365 days'"],
  ])("trims %s with the approved window", (_table, predicate) => {
    expect(SQL).toContain(predicate);
  });

  it("never deletes the newest row per site from snapshot and scan history", () => {
    expect(SQL).toMatch(/s\.id <> \(select l\.id from site_snapshots l where l\.site_id = s\.site_id order by l\.taken_at desc limit 1\)/);
    expect(SQL).toMatch(/c\.run_at < \(select max\(l\.run_at\) from security_checks l where l\.site_id = c\.site_id\)/);
    expect(SQL).toMatch(/p\.taken_at < \(select max\(l\.taken_at\) from seo_snapshots l where l\.site_id = p\.site_id and l\.source = p\.source\)/);
  });

  it("never touches the activity log, reports or GeoGrid history", () => {
    expect(SQL).not.toMatch(/delete from (activity_log|reports|geogrid)/);
  });

  it("is callable only by the service role", () => {
    expect(SQL).toContain("revoke execute on function prune_history() from public, anon, authenticated");
  });
});
