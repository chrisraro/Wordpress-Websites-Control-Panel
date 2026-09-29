import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseCareCounter, supabaseClientEvidenceReader } from "@/services/client/repo";

type Call = [string, ...unknown[]];
interface Query { table: string; calls: Call[] }
type Result = { data?: unknown; error?: unknown; count?: number | null };

/** A chainable stand-in for the supabase-js builder that records every call. */
function fakeDb(respond: (q: Query) => Result) {
  const queries: Query[] = [];
  const db = {
    from(table: string) {
      const q: Query = { table, calls: [] };
      queries.push(q);
      const builder: Record<string, unknown> = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") {
            const r = { data: null, error: null, count: null, ...respond(q) };
            return (res: (v: unknown) => void) => res(r);
          }
          return (...args: unknown[]) => { q.calls.push([prop, ...args]); return builder; };
        },
      });
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, queries };
}

const has = (q: Query, ...call: unknown[]) =>
  q.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));

describe("supabaseCareCounter", () => {
  it("counts successful manage actions plus plugin installs for one site, head-only", async () => {
    const { db, queries } = fakeDb((q) => ({ count: has(q, "like", "action", "site.manage.%") ? 3 : 2 }));
    const n = await supabaseCareCounter(db).countCompleted("s1", "2026-09-01T00:00:00.000Z");
    expect(n).toBe(5);
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.table).toBe("activity_log");
      // head:true -- a count, never rows (so never actor ids or detail).
      expect(has(q, "select", "id", { count: "exact", head: true })).toBe(true);
      expect(has(q, "eq", "site_id", "s1")).toBe(true);
      expect(has(q, "gte", "at", "2026-09-01T00:00:00.000Z")).toBe(true);
      expect(has(q, "eq", "detail->>ok", "true")).toBe(true);
    }
    expect(queries.some((q) => has(q, "eq", "action", "site.plugin_install"))).toBe(true);
  });

  it("throws a generic error that carries nothing from the database", async () => {
    const { db } = fakeDb(() => ({ error: { message: "permission denied; actor=abc" } }));
    await expect(supabaseCareCounter(db).countCompleted("s1", "x")).rejects.toThrow(/^care count unavailable$/);
  });
});

describe("service-role scope in src/services/client", () => {
  // The dashboard page may not hold a service-role client
  // (authz-read-path.test.ts); this module does, for one count. Pin that
  // it stays one count: activity_log, head-only, and nothing else.
  const dir = join(__dirname, "..", "src", "services", "client");
  const src = (f: string) => readFileSync(join(dir, f), "utf8");

  it("creates the service client only in deps.ts, which is server-only", () => {
    for (const f of ["format.ts", "summary.ts", "repo.ts"]) {
      expect(src(f)).not.toMatch(/createServiceSupabase/);
    }
    expect(src("deps.ts")).toMatch(/^import "server-only";/);
  });

  it("uses the service client for head-only activity_log counts and nothing else", () => {
    const uses = src("repo.ts").match(/serviceDb\.from\([^)]*\)[^;]*/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(uses[0]).toContain('from("activity_log")');
    expect(uses[0]).toContain("head: true");
  });
});

describe("supabaseClientEvidenceReader", () => {
  it("tallies uptime from two counts and the earliest check in the window", async () => {
    const { db, queries } = fakeDb((q) => {
      if (has(q, "eq", "ok", true)) return { count: 99 };
      if (q.calls.some((c) => c[0] === "maybeSingle")) return { data: { checked_at: "2026-09-01T00:00:00Z" } };
      return { count: 100 };
    });
    const t = await supabaseClientEvidenceReader(db).uptimeSince("s1", "2026-08-30T00:00:00Z");
    expect(t).toEqual({ total: 100, ok: 99, firstIso: "2026-09-01T00:00:00Z" });
    expect(queries.every((q) => q.table === "uptime_checks" && has(q, "eq", "site_id", "s1"))).toBe(true);
  });

  it("reports no checks as zero, not as unknown", async () => {
    const { db } = fakeDb((q) => (q.calls.some((c) => c[0] === "maybeSingle") ? { data: null } : { count: 0 }));
    expect(await supabaseClientEvidenceReader(db).uptimeSince("s1", "x")).toEqual({ total: 0, ok: 0, firstIso: null });
  });

  it("reads the newest SSL measurement, skipping checks that recorded none", async () => {
    const { db, queries } = fakeDb(() => ({ data: { ssl_days_remaining: 50, checked_at: "2026-09-29T00:00:00Z" } }));
    const r = await supabaseClientEvidenceReader(db).latestSsl("s1", "x");
    expect(r).toEqual({ days: 50, checkedAtIso: "2026-09-29T00:00:00Z" });
    expect(has(queries[0], "not", "ssl_days_remaining", "is", null)).toBe(true);
  });

  it("returns null when there is no SSL measurement", async () => {
    const { db } = fakeDb(() => ({ data: null }));
    expect(await supabaseClientEvidenceReader(db).latestSsl("s1", "x")).toBeNull();
  });
});
