import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseSecurityRepo } from "@/services/security/repo";

// feedEntriesForSlugs queried .in("software_slug", slugs) with no pagination.
// PostgREST caps a response at max_rows (1000 on Supabase), and a popular
// plugin alone carries hundreds of feed entries, so 100 slugs could silently
// lose vulnerabilities past row 1000 -- a site would grade clean while
// vulnerable. It must page with .range() under a stable .order("id").

const MAX_ROWS = 1000;

function feedRow(i: number) {
  return {
    id: `v-${String(i).padStart(5, "0")}`, title: "t", cve: null, cvss: 5,
    software_type: "plugin", software_slug: "elementor",
    affected_versions: [], fixed_in: null,
  };
}

/** A vuln_feed fake that truncates to MAX_ROWS like PostgREST does. */
function fakeDb(total: number) {
  const rows = Array.from({ length: total }, (_, i) => feedRow(i));
  const ranges: Array<[number, number]> = [];
  const orders: unknown[][] = [];
  const db = {
    from() {
      let from = 0;
      let to = Number.POSITIVE_INFINITY;
      const builder = {
        select() { return builder; },
        in() { return builder; },
        order(...args: unknown[]) { orders.push(args); return builder; },
        range(a: number, b: number) { ranges.push([a, b]); from = a; to = b; return builder; },
        then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
          const end = Math.min(to + 1, from + MAX_ROWS, rows.length);
          return Promise.resolve({ data: rows.slice(from, end), error: null }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, ranges, orders };
}

describe("supabaseSecurityRepo.feedEntriesForSlugs", () => {
  it("returns every matching entry past PostgREST's max_rows", async () => {
    const { db, ranges, orders } = fakeDb(2500);
    const out = await supabaseSecurityRepo(db).feedEntriesForSlugs([{ type: "plugin", slug: "elementor" }]);
    expect(out).toHaveLength(2500);
    expect(new Set(out.map((e) => e.id)).size).toBe(2500);
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(orders[0]).toEqual(["id", { ascending: true }]);
  });

  it("stops after a single short page", async () => {
    const { db, ranges } = fakeDb(3);
    const out = await supabaseSecurityRepo(db).feedEntriesForSlugs([{ type: "plugin", slug: "elementor" }]);
    expect(out).toHaveLength(3);
    expect(ranges).toEqual([[0, 999]]);
  });
});
