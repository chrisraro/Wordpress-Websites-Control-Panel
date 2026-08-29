import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseSitesRepo } from "@/services/sites/repo";

// Spec §5.2: mcp_endpoint and wp_username are credential-adjacent, and a
// client's page reads (listSites/getSite) go through the user-scoped client
// via readDbFor -- so anything in the shared select list is something a
// client with a site grant can pull straight over PostgREST with their own
// JWT. This pins SITE_COLUMNS (the list listSites and getSite share) to
// never carry those two columns again, and pins getSiteConnection -- the
// one staff-only surface that still needs them -- to select exactly them,
// nothing more. Migration 0012_revoke_site_credential_columns.sql is the
// database-level backstop; this is the code-level one, and it must land
// first (see that migration's header for why the order matters).

function fakeDb(captured: { table?: string; selected: string[] }) {
  return {
    from(table: string) {
      captured.table = table;
      const builder = {
        select(columns: string) {
          captured.selected.push(columns);
          return builder;
        },
        order() {
          return builder;
        },
        eq() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
        then(onFulfilled: (v: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(onFulfilled);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe("SITE_COLUMNS (shared by listSites and getSite)", () => {
  it("listSites never selects mcp_endpoint or wp_username", async () => {
    const captured: { table?: string; selected: string[] } = { selected: [] };
    await supabaseSitesRepo(fakeDb(captured)).listSites();

    expect(captured.table).toBe("sites");
    expect(captured.selected).toHaveLength(1);
    expect(captured.selected[0]).not.toContain("mcp_endpoint");
    expect(captured.selected[0]).not.toContain("wp_username");
  });

  it("getSite never selects mcp_endpoint or wp_username", async () => {
    const captured: { table?: string; selected: string[] } = { selected: [] };
    await supabaseSitesRepo(fakeDb(captured)).getSite("site-1");

    expect(captured.table).toBe("sites");
    expect(captured.selected).toHaveLength(1);
    expect(captured.selected[0]).not.toContain("mcp_endpoint");
    expect(captured.selected[0]).not.toContain("wp_username");
  });
});

describe("supabaseSitesRepo.getSiteConnection", () => {
  it("selects exactly mcp_endpoint and wp_username, nothing else", async () => {
    const captured: { table?: string; selected: string[] } = { selected: [] };
    await supabaseSitesRepo(fakeDb(captured)).getSiteConnection("site-1");

    expect(captured.table).toBe("sites");
    expect(captured.selected).toHaveLength(1);
    const columns = captured.selected[0].split(",").map((c) => c.trim());
    expect(columns.sort()).toEqual(["mcp_endpoint", "wp_username"]);
  });
});
