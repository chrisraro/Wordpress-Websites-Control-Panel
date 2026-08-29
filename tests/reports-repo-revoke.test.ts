import { describe, expect, it } from "vitest";
import { supabaseReportsRepo } from "@/services/reports/repo";
import type { SupabaseClient } from "@supabase/supabase-js";

// revokeReportAction (src/app/(dashboard)/sites/[id]/reports-actions.ts) checks
// the caller's access to the `siteId` argument, not to whatever site the
// report at `reportId` actually belongs to. Before this fix, repo.revoke(id)
// updated `reports` filtered only on `id` -- a caller holding access to one
// site could supply a reportId belonging to a *different* site and have its
// share_token nulled out anyway. This proves the repo now filters the update
// on both `id` and `site_id`, so a mismatched pair touches zero rows.

function fakeDb(captured: { table?: string; patch?: unknown; filters: Record<string, string> }) {
  return {
    from(table: string) {
      captured.table = table;
      return {
        update(patch: unknown) {
          captured.patch = patch;
          const builder = {
            eq(column: string, value: string) {
              captured.filters[column] = value;
              return builder;
            },
            then(onFulfilled: (v: { error: null }) => unknown) {
              return Promise.resolve({ error: null }).then(onFulfilled);
            },
          };
          return builder;
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("supabaseReportsRepo.revoke", () => {
  it("scopes the update to both the report id and the site id", async () => {
    const captured: { table?: string; patch?: unknown; filters: Record<string, string> } = { filters: {} };
    const db = fakeDb(captured);

    await supabaseReportsRepo(db).revoke("report-from-site-a", "site-a");

    expect(captured.table).toBe("reports");
    expect(captured.patch).toEqual({ share_token: null });
    // Both predicates must be present. In the live database this means a
    // report that belongs to a different site than `site-a` matches zero
    // rows and is left untouched, even if the id is correct.
    expect(captured.filters).toEqual({ id: "report-from-site-a", site_id: "site-a" });
  });
});
