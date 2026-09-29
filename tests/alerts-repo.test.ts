import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAlertsRepo } from "@/services/alerts/repo";
import { ALERT_ACTION, SYSTEM_ACTOR } from "@/services/alerts/types";

type Call = [string, ...unknown[]];
interface Query { table: string; calls: Call[] }

/**
 * Minimal chainable stand-in for the supabase-js query builder: records every
 * call and resolves with whatever `respond` returns for that query.
 */
function fakeDb(respond: (q: Query) => { data?: unknown; error?: { message: string } | null }) {
  const queries: Query[] = [];
  const inserts: Array<{ table: string; rows: unknown }> = [];
  const db = {
    from(table: string) {
      const q: Query = { table, calls: [] };
      queries.push(q);
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "is", "order", "limit", "range", "neq"]) {
        builder[m] = (...args: unknown[]) => { q.calls.push([m, ...args]); return builder; };
      }
      builder.insert = async (rows: unknown) => { inserts.push({ table, rows }); return respond({ table, calls: [["insert", rows]] }); };
      builder.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null, ...respond(q) }).then(ok, bad);
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, queries, inserts };
}

const has = (q: Query, ...call: unknown[]) =>
  q.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));

const NOW = new Date("2026-09-29T12:00:00Z");

describe("supabaseAlertsRepo.loadState", () => {
  function setup() {
    return fakeDb((q) => {
      if (q.table === "sites") {
        return { data: [
          { id: "s1", name: "Alpha", status: "connected" },
          { id: "s2", name: "Off", status: "disabled" },
        ] };
      }
      if (q.table === "uptime_checks") {
        return { data: [{ site_id: "s1", ok: false, checked_at: "t1", http_status: 500, ssl_days_remaining: 5 }] };
      }
      if (q.table === "site_vulnerabilities") {
        return { data: [{
          id: "v1", site_id: "s1", component: "akismet", installed_version: "1", severity: "high",
          status: "open", first_seen: "t", vuln_feed: { cvss: "9.1", title: "T", cve: "CVE-1" },
        }] };
      }
      if (q.table === "jobs") {
        return { data: [{ id: "j1", site_id: null, type: "vuln_feed_refresh", finished_at: "t", last_error: "e", dismissed_at: null }] };
      }
      if (q.table === "activity_log") {
        if (has(q, "eq", "site_id", "s1")) {
          return { data: [{ site_id: "s1", at: "a1", detail: { kind: "site_down", key: "k" } }] };
        }
        return { data: [
          { site_id: "s1", at: "a2", detail: { kind: "ssl_expiring", key: "5" } },
          { site_id: "s1", at: "a3", detail: { kind: "bogus", key: "x" } },
          { site_id: "s1", at: "a4", detail: null },
        ] };
      }
      return { data: [] };
    });
  }

  it("reads only non-secret site columns", async () => {
    const { db, queries } = setup();
    await supabaseAlertsRepo(db).loadState(NOW);
    const sites = queries.find((q) => q.table === "sites")!;
    expect(sites.calls[0]).toEqual(["select", "id,name,status"]);
  });

  it("loads the latest two uptime checks and last up/down alert per active site only", async () => {
    const { db, queries } = setup();
    const state = await supabaseAlertsRepo(db).loadState(NOW);
    const uptime = queries.filter((q) => q.table === "uptime_checks");
    expect(uptime).toHaveLength(1);
    expect(has(uptime[0], "eq", "site_id", "s1")).toBe(true);
    expect(has(uptime[0], "limit", 2)).toBe(true);
    expect(state.uptime).toHaveLength(1);
    const transitions = queries.filter((q) => q.table === "activity_log" && has(q, "eq", "site_id", "s1"));
    expect(transitions).toHaveLength(1);
    expect(has(transitions[0], "eq", "action", ALERT_ACTION)).toBe(true);
    expect(has(transitions[0], "limit", 1)).toBe(true);
  });

  it("maps vuln_feed cvss to a number and filters open vulns by first_seen", async () => {
    const { db, queries } = setup();
    const state = await supabaseAlertsRepo(db).loadState(NOW);
    expect(state.vulns[0]).toMatchObject({ id: "v1", cvss: 9.1, title: "T", cve: "CVE-1", severity: "high" });
    const q = queries.find((x) => x.table === "site_vulnerabilities")!;
    expect(has(q, "eq", "status", "open")).toBe(true);
    expect(has(q, "gte", "first_seen", "2026-09-22T12:00:00.000Z")).toBe(true);
  });

  it("reads failed, undismissed jobs from the last 24h", async () => {
    const { db, queries } = setup();
    const state = await supabaseAlertsRepo(db).loadState(NOW);
    expect(state.failedJobs).toHaveLength(1);
    const q = queries.find((x) => x.table === "jobs")!;
    expect(has(q, "eq", "status", "failed")).toBe(true);
    expect(has(q, "is", "dismissed_at", null)).toBe(true);
    expect(has(q, "gte", "finished_at", "2026-09-28T12:00:00.000Z")).toBe(true);
  });

  it("merges history and drops rows with a malformed detail", async () => {
    const { db } = setup();
    const state = await supabaseAlertsRepo(db).loadState(NOW);
    expect(state.history).toEqual(expect.arrayContaining([
      { site_id: "s1", kind: "site_down", key: "k", at: "a1" },
      { site_id: "s1", kind: "ssl_expiring", key: "5", at: "a2" },
    ]));
    expect(state.history).toHaveLength(2);
  });

  it("throws when a query fails", async () => {
    const { db } = fakeDb((q) => (q.table === "jobs" ? { error: { message: "nope" } } : { data: [] }));
    await expect(supabaseAlertsRepo(db).loadState(NOW)).rejects.toThrow(/nope/);
  });
});

describe("supabaseAlertsRepo.recordSent", () => {
  it("writes one alert.sent row per dedupe key, as the system actor", async () => {
    const { db, inserts } = fakeDb(() => ({ error: null }));
    await supabaseAlertsRepo(db).recordSent([
      { kind: "jobs_failed", site_id: "s1", site: "Alpha", message: "m", keys: ["j1", "j2"] },
      { kind: "site_down", site_id: "s2", site: "Beta", message: "m", keys: ["t"] },
    ]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("activity_log");
    expect(inserts[0].rows).toEqual([
      { actor: SYSTEM_ACTOR, site_id: "s1", action: ALERT_ACTION, detail: { kind: "jobs_failed", key: "j1" } },
      { actor: SYSTEM_ACTOR, site_id: "s1", action: ALERT_ACTION, detail: { kind: "jobs_failed", key: "j2" } },
      { actor: SYSTEM_ACTOR, site_id: "s2", action: ALERT_ACTION, detail: { kind: "site_down", key: "t" } },
    ]);
  });

  it("throws when the insert fails", async () => {
    const { db } = fakeDb(() => ({ error: { message: "denied" } }));
    await expect(supabaseAlertsRepo(db).recordSent([
      { kind: "site_down", site_id: "s2", site: "Beta", message: "m", keys: ["t"] },
    ])).rejects.toThrow(/denied/);
  });
});
