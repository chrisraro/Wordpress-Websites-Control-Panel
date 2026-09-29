import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseSecurityRepo } from "@/services/security/repo";

// 0029 adds uptime_checks.frameable. Code can deploy before the migration is
// applied; uptime recording (and every alert downstream of it) must not stop
// because of one missing column.

function fakeDb(opts: { hasColumn: boolean; rows?: Record<string, unknown>[] }) {
  const inserts: Record<string, unknown>[][] = [];
  const db = {
    from: () => ({
      insert: async (rows: Record<string, unknown>[]) => {
        if (!opts.hasColumn && rows.some((r) => "frameable" in r)) {
          return { error: { code: "PGRST204", message: "Could not find the 'frameable' column of 'uptime_checks'" } };
        }
        inserts.push(rows);
        return { error: null };
      },
      select: () => {
        const chain = {
          eq: () => chain, gte: () => chain, order: () => chain,
          limit: async () => ({ data: opts.rows ?? [], error: null }),
        };
        return chain;
      },
    }),
  };
  return { db: db as unknown as SupabaseClient, inserts };
}

const row = { site_id: "s1", http_status: 200, response_ms: 90, ssl_days_remaining: 60, ok: true, frameable: true };

describe("insertUptime and the frameable column", () => {
  it("writes frameable when the column exists", async () => {
    const { db, inserts } = fakeDb({ hasColumn: true });
    await supabaseSecurityRepo(db).insertUptime([row]);
    expect(inserts[0][0]).toMatchObject({ frameable: true });
  });

  it("retries without it before 0029 is applied, instead of losing the uptime row", async () => {
    const { db, inserts } = fakeDb({ hasColumn: false });
    await supabaseSecurityRepo(db).insertUptime([row]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).not.toHaveProperty("frameable");
    expect(inserts[0][0]).toMatchObject({ site_id: "s1", ok: true });
  });
});

describe("uptimeSummary", () => {
  it("reports the failure streak, the newest reading's time and its frameability", async () => {
    const { db } = fakeDb({
      hasColumn: true,
      rows: [
        { ok: false, response_ms: null, ssl_days_remaining: 60, checked_at: "2026-09-29T12:00:00Z", frameable: null },
        { ok: false, response_ms: null, ssl_days_remaining: 60, checked_at: "2026-09-29T11:55:00Z", frameable: null },
        { ok: true, response_ms: 80, ssl_days_remaining: 60, checked_at: "2026-09-29T11:50:00Z", frameable: true },
        { ok: true, response_ms: 80, ssl_days_remaining: 60, checked_at: "2026-09-29T11:45:00Z", frameable: true },
      ],
    });
    const s = await supabaseSecurityRepo(db).uptimeSummary("s1");
    expect(s).toMatchObject({
      latestOk: false, failStreak: 2, latestAt: "2026-09-29T12:00:00Z", uptime24h: 50,
      // The newest verdict that exists: a down site has no headers to judge.
      frameable: true,
    });
  });

  it("leaves frameable null when no reading has judged it (pre-0029 rows)", async () => {
    const { db } = fakeDb({
      hasColumn: false,
      rows: [{ ok: true, response_ms: 80, ssl_days_remaining: 60, checked_at: "2026-09-29T12:00:00Z" }],
    });
    expect((await supabaseSecurityRepo(db).uptimeSummary("s1")).frameable).toBeNull();
  });
});
