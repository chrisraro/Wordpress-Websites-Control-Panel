import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseReportsRepo } from "@/services/reports/repo";

// get_report_link (Task 8b) needs to fetch one report by its own id -- the
// existing repo only supported listForSite and getByToken (by share_token).
// These tests pin: the exact column list selected (must match listForSite's
// COLUMNS, including share_token -- callers decide whether to expose it, the
// repo doesn't redact), the eq("id", ...) filter, maybeSingle's
// null-not-undefined miss, and that a query error throws with the Supabase
// error's own message.

function fakeDb(result: { data?: unknown; error?: { message: string } | null }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder = {
    select(...args: unknown[]) { calls.push({ method: "select", args }); return builder; },
    eq(...args: unknown[]) { calls.push({ method: "eq", args }); return builder; },
    maybeSingle() {
      calls.push({ method: "maybeSingle", args: [] });
      // No `?? null` here: getById's own `?? null` guard is what the
      // "returns null, not undefined" test actually exercises.
      return Promise.resolve({ data: result.data, error: result.error ?? null });
    },
  };
  const db = {
    from(table: string) { calls.push({ method: "from", args: [table] }); return builder; },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const ROW = {
  id: "3d8a5f6b-7e9a-4c14-8f5d-8b6e4c2a9d73",
  site_id: "1b6e3d4f-5c7e-4a92-8d3b-6f4c2a9e7b51",
  generated_at: "2026-09-01T00:00:00Z",
  sections: ["overview"],
  period_start: "2026-08-01",
  period_end: "2026-08-31",
  storage_path: "reports/site/report.pdf",
  share_token: "abc123",
  auto: false,
};

describe("supabaseReportsRepo.getById", () => {
  it("queries reports, selects the full column list, and filters on id", async () => {
    const { db, calls } = fakeDb({ data: ROW });
    await supabaseReportsRepo(db).getById(ROW.id);

    expect(calls[0]).toEqual({ method: "from", args: ["reports"] });
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          method: "select",
          args: ["id,site_id,generated_at,sections,period_start,period_end,storage_path,share_token,auto"],
        },
        { method: "eq", args: ["id", ROW.id] },
      ]),
    );
  });

  it("returns the row when found", async () => {
    const { db } = fakeDb({ data: ROW });
    const result = await supabaseReportsRepo(db).getById(ROW.id);
    expect(result).toEqual(ROW);
  });

  it("returns null, not undefined, when no row matches", async () => {
    const { db } = fakeDb({ data: undefined });
    const result = await supabaseReportsRepo(db).getById("missing-id");
    expect(result).toBeNull();
    expect(result === undefined).toBe(false);
  });

  it("throws with the Supabase error's message when the query errors", async () => {
    const { db } = fakeDb({ error: { message: "connection reset" } });
    await expect(supabaseReportsRepo(db).getById(ROW.id)).rejects.toThrow("connection reset");
  });
});
