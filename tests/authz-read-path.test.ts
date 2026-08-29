import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// Phase 9a's whole point is that a client's reads go through `readDbFor`,
// which routes them through the user-scoped Supabase client so RLS (not
// application code) decides what comes back. `createServiceSupabase()`
// bypasses RLS entirely — dropping it into a dashboard page silently turns
// every access check on that page back into decoration, and nothing else in
// the test suite would catch it (each page's own gate would still look
// correct; only the actual rows returned would be wrong). This is a
// source-scan, not a runtime test, precisely because that regression doesn't
// show up in a unit test of the gate — it shows up in what the query returns
// against a real, RLS-enabled database.
const DASHBOARD_DIR = join(__dirname, "..", "src", "app", "(dashboard)");

function findPageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findPageFiles(full));
    } else if (entry === "page.tsx") {
      out.push(full);
    }
  }
  return out;
}

const pageFiles = findPageFiles(DASHBOARD_DIR);

// `/users` and its sub-routes are the one documented exception: they read
// `last_sign_in_at` and other invite state via `auth.admin.*`, which only
// exists on the service-role client, and the whole surface is staff-only,
// gated in application code via requirePermission("users.manage") rather
// than by RLS (see docs/superpowers/specs/2026-08-29-phase9b-user-management
// -design.md §2.1 and §7). It is never reachable from a user's own session.
const USERS_DIR = join(DASHBOARD_DIR, "users");
// Match on a path boundary, not a character prefix: `f.startsWith(USERS_DIR)`
// would also exclude a sibling directory that merely begins with "users"
// (e.g. "users-export/", "userscript/") without ever checking it — exactly
// the regression this test exists to catch.
const rlsGovernedPageFiles = pageFiles.filter(
  (f) => f !== join(USERS_DIR, "page.tsx") && !f.startsWith(USERS_DIR + sep),
);

describe("dashboard page reads stay on the RLS-governed path", () => {
  it("found at least one page.tsx to check (guards against a rotted glob)", () => {
    expect(pageFiles.length).toBeGreaterThan(0);
  });

  it.each(rlsGovernedPageFiles)("%s does not import createServiceSupabase", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/createServiceSupabase/);
  });
});

describe("the site overview page never unconditionally renders credentials-adjacent fields", () => {
  // Spec §5.2: mcp_endpoint and wp_username are credentials-adjacent and
  // must be omitted outright for anyone who does not hold sites.view_all,
  // not merely blanked. They are no longer even fetched into `site`
  // (SITE_COLUMNS/SiteRow dropped them) -- the page fetches them separately
  // as `connection`. Pinning this here means a future edit that moves the
  // row out of that guard (or adds a second, unguarded place that prints
  // either value) fails a test instead of shipping.
  const source = readFileSync(
    join(DASHBOARD_DIR, "sites", "[id]", "page.tsx"),
    "utf8",
  );

  // mcp_endpoint and wp_username came off SiteRow and SITE_COLUMNS entirely
  // (spec §5.2) -- `site` (from getSite) never carries them anymore. The
  // page now fetches them separately, via `connection`, which is `null`
  // unless the viewer holds `sites.view_all`. This pin was previously
  // written against `isClient ? null : ...` -- the final whole-branch
  // review found that gate wrong: it coincides with the permission check
  // only under today's seeded matrix, and stops matching the moment an
  // admin unticks sites.view_all for a staff role (this phase ships that
  // editor), at which point a role check would keep serving these fields
  // to someone the database itself would refuse. Pinning the permission
  // form here, not the role form, is what stops that regression from
  // creeping back in without weakening what this test catches.
  it("only fetches the connection fields when the viewer holds sites.view_all", () => {
    const occurrences = source.split("supabaseSitesRepo(db).getSiteConnection(id)").length - 1;
    expect(occurrences).toBe(1);
    expect(source).toContain(
      'const connection = canViewAdminUsers ? await supabaseSitesRepo(db).getSiteConnection(id) : null;',
    );
  });

  it("does not render mcp_endpoint unconditionally", () => {
    // The only occurrence of `connection.mcp_endpoint` must sit inside the
    // `connection ? [...] : []` row-building expression, which is `[]`
    // whenever `connection` is `null` — i.e. whenever the viewer is a
    // client — never used bare (e.g. as a fallback rendered regardless of
    // role).
    const occurrences = source.split("connection.mcp_endpoint").length - 1;
    expect(occurrences).toBe(1);
    expect(source).toContain('connection ? [{ term: "MCP endpoint", value: connection.mcp_endpoint');
  });

  it("does not render wp_username unconditionally", () => {
    const occurrences = source.split("connection.wp_username").length - 1;
    // One occurrence inside the connection-gated Connection-card row, one
    // inside the connection-gated "Copy WP username" control. Both are
    // gated on the same `connection` value, which is only non-null for a
    // non-client viewer; there must be no third, unguarded occurrence.
    expect(occurrences).toBe(2);
    expect(source).toContain('connection ? [{ term: "WP user", value: connection.wp_username');
    expect(source).toContain("{connection && (");
  });

  it("does not render WordPress administrator logins/emails unconditionally", () => {
    // site_admin_users (0011_site_admin_users.sql) is staff-only, gated by
    // the same `sites.view_all` permission its RLS policy checks -- not by
    // role. Pinning the occurrence count here means a refactor that lifts
    // the Administrators card out of its guard (or adds a second,
    // unguarded place that prints a login or email) fails a test instead
    // of shipping.
    const loginOccurrences = source.split("u.user_login").length - 1;
    const emailOccurrences = source.split("u.user_email").length - 1;
    expect(loginOccurrences).toBe(1);
    expect(emailOccurrences).toBe(1);
    // The gate must be the permission the RLS policy checks, not the
    // `isClient` role check: they only coincide under today's seeded
    // permission matrix, and an admin editing the matrix must not leave
    // this page rendering data the database would now refuse.
    expect(source).toContain('const canViewAdminUsers = can(viewer, "sites.view_all");');
    expect(source).toContain("canViewAdminUsers ? await supabaseAdminUsersRepo(db).latestAdminUsers(id) : null");
    expect(source).toContain("{canViewAdminUsers && (");
  });

  it("does not read activity_log unconditionally", () => {
    // activity_log's own RLS policy (0008_rls_scoped.sql:197-199) requires
    // sites.view_all -- but this read runs on the service-role client
    // (readDbFor returns it for any non-client viewer), which bypasses RLS
    // entirely, so before this fix nothing on this page enforced that
    // policy's rule at all. Pinning the guarded form here means a refactor
    // that drops this check (or restores an unconditional `.from
    // ("activity_log")` read) fails a test instead of shipping.
    const occurrences = source.split('.from("activity_log")').length - 1;
    expect(occurrences).toBe(1);
    expect(source).toContain("const { data: activity } = canViewAdminUsers");
  });

  it("gates the 'Open wp-admin' link on the same permission as the rest of this page, not an isClient role check", () => {
    // Finding 9 of the final whole-branch review: this was the last
    // instance of the `isClient` pattern on this page. A developer whose
    // sites.view_all was unticked kept the link, and on a site with a
    // renamed admin path that discloses it. `isClient` must not appear on
    // this page at all now.
    expect(source).not.toMatch(/isClient/);
    expect(source).toContain("{canViewAdminUsers && (");
    expect(source.split("{canViewAdminUsers && (").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("gates the Recent activity card the same way as the Administrators card beside it", () => {
    // Finding 9: Recent activity used to always render, showing a generic
    // empty state to anyone lacking sites.view_all while Administrators hid
    // itself under that same condition -- the two cards must agree.
    const recentActivityIndex = source.indexOf("Recent activity");
    const guardIndex = source.lastIndexOf("{canViewAdminUsers && (", recentActivityIndex);
    expect(guardIndex).toBeGreaterThan(-1);
    // No unrelated closing of the JSX conditional between the guard and the
    // card's own title -- i.e. the guard actually wraps this card.
    expect(source.slice(guardIndex, recentActivityIndex)).not.toContain(")}");
  });
});
