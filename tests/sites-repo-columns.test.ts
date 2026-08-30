import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
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
  it("listSites never selects mcp_endpoint, wp_username, or app_password_encrypted", async () => {
    const captured: { table?: string; selected: string[] } = { selected: [] };
    await supabaseSitesRepo(fakeDb(captured)).listSites();

    expect(captured.table).toBe("sites");
    expect(captured.selected).toHaveLength(1);
    expect(captured.selected[0]).not.toContain("mcp_endpoint");
    expect(captured.selected[0]).not.toContain("wp_username");
    expect(captured.selected[0]).not.toContain("app_password_encrypted");
  });

  it("getSite never selects mcp_endpoint, wp_username, or app_password_encrypted", async () => {
    const captured: { table?: string; selected: string[] } = { selected: [] };
    await supabaseSitesRepo(fakeDb(captured)).getSite("site-1");

    expect(captured.table).toBe("sites");
    expect(captured.selected).toHaveLength(1);
    expect(captured.selected[0]).not.toContain("mcp_endpoint");
    expect(captured.selected[0]).not.toContain("wp_username");
    expect(captured.selected[0]).not.toContain("app_password_encrypted");
  });

  // Migration 0012_revoke_site_credential_columns.sql revokes `select` on
  // `sites` from `authenticated` at the table level, then re-grants it on
  // an explicit column list -- PostgREST fails the WHOLE query (not just
  // the offending column) if SITE_COLUMNS ever names a column that list
  // does not also grant. This is the invariant that actually matters: it
  // is not enough for SITE_COLUMNS to merely exclude the three
  // credential-adjacent columns (the two tests above); it must be a subset
  // of -- here, exactly equal to -- what 0012 grants, or a future
  // SITE_COLUMNS change 500s every client-role page the moment it ships
  // without 0012 being amended in the same deploy.
  it("matches exactly the column list the migrations grant to authenticated", async () => {
    const captured: { table?: string; selected: string[] } = { selected: [] };
    await supabaseSitesRepo(fakeDb(captured)).listSites();
    const siteColumns = captured.selected[0].split(",").map((c) => c.trim()).sort();

    // Scans EVERY migration, not just 0012. Column grants accumulate: 0012
    // established the column-level list, and each later migration that adds
    // a readable column grants that column too (0017 does, for
    // `environment`). Reading only 0012 made this test fail the moment a
    // correctly-granted column was added -- the right invariant is the union
    // of what the migrations grant, which is what the database ends up with.
    const migrationsDir = path.resolve(__dirname, "../supabase/migrations");
    const granted = new Set<string>();
    for (const file of readdirSync(migrationsDir).sort()) {
      if (!file.endsWith(".sql")) continue;
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      // A literal regex, not new RegExp over a string: "\(" inside a string
      // literal is just "(", which turns the intended literal paren into a
      // capture group and silently matches nothing.
      const re = /grant select \(([^)]*?)\) on sites to authenticated;/g;
      for (const m of sql.matchAll(re)) {
        for (const col of m[1].split(",")) {
          const name = col.trim();
          if (name) granted.add(name);
        }
      }
    }
    expect(granted.size, "no column grants on sites found in any migration").toBeGreaterThan(0);
    const grantedColumns = [...granted].sort();

    expect(siteColumns).toEqual(grantedColumns);
  });
});

describe("supabaseSitesRepo.getSiteConnection", () => {
  it("selects the staff-only connection columns and never the password", async () => {
    const captured: { table?: string; selected: string[] } = { selected: [] };
    await supabaseSitesRepo(fakeDb(captured)).getSiteConnection("site-1");

    expect(captured.table).toBe("sites");
    expect(captured.selected).toHaveLength(1);
    const columns = captured.selected[0].split(",").map((c) => c.trim()).sort();

    // origin_ip/origin_sni joined this read with 0019: they describe a route
    // to the origin past a CDN, which is staff-only information of the same
    // class as mcp_endpoint. Like the rest of this list they are deliberately
    // NOT in SITE_COLUMNS and NOT granted to `authenticated`, so a client can
    // never select them -- the two tests above pin that boundary.
    expect(columns).toEqual(["mcp_endpoint", "origin_ip", "origin_sni", "wp_username"]);

    // The invariant that must never relax, stated separately from the exact
    // list so that widening the list above can never quietly admit it.
    expect(captured.selected[0]).not.toContain("app_password_encrypted");
  });
});
