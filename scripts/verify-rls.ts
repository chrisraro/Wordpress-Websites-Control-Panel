/**
 * Proves the RLS policies in supabase/migrations/0008_rls_scoped.sql and
 * 0009_rbac_write_scope.sql actually refuse cross-tenant and cross-role
 * access in the LIVE database. Every prior check in this phase was
 * structural (regexes over SQL text, mocked guards in Vitest) — a policy
 * that was never executed was never tested. This script executes real
 * queries, as real signed-in users, against real Postgres.
 *
 * Two throwaway users, two shapes:
 *   - a `client` with a single `read` site grant (the original coverage,
 *     against 0008's read/manage split on `has_site_access`).
 *   - a `content_writer` with NO `user_site_access` rows at all (staff see
 *     every site through `sites.view_all` and need no grant) — this is the
 *     shape that caught the 0009 regression: `has_site_access(site_id,
 *     'manage')` short-circuits true on `sites.view_all`, a READ
 *     permission, before ever looking at `min_level`, so every child-table
 *     `_write` policy in 0008 was silently unenforced for any staff role.
 *     0009's `has_site_grant_at_least()` never consults `sites.view_all`;
 *     the content_writer section below fails before 0009 is applied and
 *     passes after.
 *
 * Deliberately NOT part of `npm test` (not a Vitest file): it creates
 * throwaway Supabase Auth users, mutates RBAC tables, and needs live
 * credentials. Run it manually, deliberately:
 *
 *   npm run verify:rls
 *   (or: node --experimental-strip-types scripts/verify-rls.ts)
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
 * SUPABASE_SERVICE_ROLE_KEY in .env.local (same file the app itself reads).
 *
 * The database needs at least two rows in `sites`: the throwaway `client`
 * user is granted exactly one (read-level), and every assertion about the
 * *other* site proves the grant boundary rather than an empty table.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// Same manual .env.local loader as scripts/bootstrap-admin.ts — this is a
// plain script, not a Next.js request, so nothing else populates process.env.
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}

const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const rawAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const rawServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!rawUrl || !rawAnonKey || !rawServiceKey) {
  throw new Error(
    "Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
}
// Reassigned to plain `string` bindings: TS does not carry the narrowing
// above into `main`, which closes over these as a nested function declared
// later in the module.
const supabaseUrl: string = rawUrl;
const anonKey: string = rawAnonKey;
const serviceKey: string = rawServiceKey;

// service-role: bypasses RLS entirely. Used only to seed and tear down the
// fixture — never to run the assertions themselves.
const admin: SupabaseClient = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

type Assertion = { name: string; pass: boolean; detail?: string };
const assertions: Assertion[] = [];

function record(name: string, pass: boolean, detail?: string): void {
  assertions.push({ name, pass, detail });
  const line = `${pass ? "PASS" : "FAIL"} - ${name}${detail ? `: ${detail}` : ""}`;
  console.log(line);
}

// Assertions 4 and 5 treat an error response as proof RLS refused the write.
// That is only true if the error IS an RLS refusal -- a constraint
// violation, a network blip, or an exception raised inside authorize() would
// also come back as a truthy `error` and would otherwise be misreported as
// "correctly rejected". PostgREST surfaces a Postgres RLS policy violation
// as SQLSTATE 42501 with a message containing "row-level security"; require
// one of those two signals before treating an error as a pass.
function isRlsRefusal(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42501") return true;
  return typeof error.message === "string" && /row-level security/i.test(error.message);
}

async function main(): Promise<void> {
  // Read the live site ids at runtime -- never hardcode them.
  const { data: sites, error: sitesErr } = await admin
    .from("sites")
    .select("id,name")
    .order("created_at", { ascending: true });
  if (sitesErr) throw new Error(`could not read sites: ${sitesErr.message}`);
  if (!sites || sites.length < 2) {
    throw new Error(
      `verify-rls needs at least 2 rows in sites to prove a grant boundary; found ${sites?.length ?? 0}`,
    );
  }
  const granted = sites[0]!;
  const ungranted = sites[1]!;

  const email = `verify-rls-${randomBytes(6).toString("hex")}@ocs-test.invalid`;
  const password = randomBytes(24).toString("base64"); // never logged, never hardcoded

  let userId: string | undefined;
  let scoped: SupabaseClient | undefined;
  let insertedSnapshotId: string | undefined;
  let seededJobId: string | undefined;
  let seededSnapshotId: string | undefined;
  let mutatedSiteName: { id: string; name: string } | undefined;

  // --- content_writer fixture state (0009 regression coverage) ---
  let cwUserId: string | undefined;
  let cwScoped: SupabaseClient | undefined;
  let cwSeededReportId: string | undefined;
  let cwLeakedReportShareToken: { id: string; shareToken: string | null } | undefined;
  let cwSeededSecurityCheckId: string | undefined;
  let cwInsertedSiteSnapshotId: string | undefined;
  let cwInsertedSeoSnapshotId: string | undefined;

  try {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr) throw new Error(`could not create throwaway user: ${createErr.message}`);
    userId = created.user!.id;

    const { error: roleErr } = await admin
      .from("user_roles")
      .insert({ user_id: userId, role: "client" });
    if (roleErr) throw new Error(`could not seed user_roles: ${roleErr.message}`);

    const { error: grantErr } = await admin
      .from("user_site_access")
      .insert({ user_id: userId, site_id: granted.id, access_level: "read" });
    if (grantErr) throw new Error(`could not seed user_site_access: ${grantErr.message}`);

    // Assertion 6 needs at least one real row in `jobs` to be meaningful --
    // otherwise "zero rows" could just mean an empty table, not a proven
    // refusal. Seed one, terminal-state, if none exists. status='done' is
    // excluded by claim_jobs()'s `status = 'pending'` filter (0002_jobs_claim.sql),
    // so this fixture can never be picked up and executed against a real site.
    const { data: existingJobs, error: existingJobsErr } = await admin
      .from("jobs")
      .select("id")
      .limit(1);
    if (existingJobsErr) throw new Error(`could not read jobs: ${existingJobsErr.message}`);
    if (!existingJobs || existingJobs.length === 0) {
      const { data: fixture, error: fixtureErr } = await admin
        .from("jobs")
        .insert({ type: "rls_verification_probe", status: "done", payload: {} })
        .select("id")
        .single();
      if (fixtureErr) throw new Error(`could not seed jobs fixture: ${fixtureErr.message}`);
      seededJobId = fixture!.id as string;
    }

    // Assertion 3 needs the UNGRANTED site to actually have a row in
    // site_snapshots -- otherwise "select returns zero rows" is true
    // whether or not RLS works, because the table would be empty for that
    // site regardless. Seed one if none exists, same reasoning as the jobs
    // fixture above.
    const { data: existingSnapshots, error: existingSnapshotsErr } = await admin
      .from("site_snapshots")
      .select("id")
      .eq("site_id", ungranted.id)
      .limit(1);
    if (existingSnapshotsErr) {
      throw new Error(`could not read site_snapshots: ${existingSnapshotsErr.message}`);
    }
    if (!existingSnapshots || existingSnapshots.length === 0) {
      const { data: fixture, error: fixtureErr } = await admin
        .from("site_snapshots")
        .insert({ site_id: ungranted.id, payload: { rls_verification_probe: true } })
        .select("id")
        .single();
      if (fixtureErr) throw new Error(`could not seed site_snapshots fixture: ${fixtureErr.message}`);
      seededSnapshotId = fixture!.id as string;
    }

    // Sign in as the throwaway user with the ANON key -- this is the same
    // client shape src/lib/authz/db.ts hands a `client`-role viewer
    // (readDbFor), so the assertions below run through the exact path a real
    // client account uses, not a simulation of it.
    scoped = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
    const { error: signInErr } = await scoped.auth.signInWithPassword({ email, password });
    if (signInErr) throw new Error(`sign-in as throwaway client failed: ${signInErr.message}`);

    // --- Assertion 1: select on sites returns exactly the granted site ---
    {
      const { data, error } = await scoped.from("sites").select("id");
      if (error) {
        record("select sites returns exactly the granted site", false, `query errored: ${error.message}`);
      } else if (data.length === 1 && data[0]!.id === granted.id) {
        record("select sites returns exactly the granted site", true);
      } else {
        record(
          "select sites returns exactly the granted site",
          false,
          `expected exactly [${granted.id}], got [${data.map((r) => r.id).join(", ")}]`,
        );
      }
    }

    // --- Assertion 2: select on sites filtered to the ungranted id returns zero rows ---
    {
      const { data, error } = await scoped.from("sites").select("id").eq("id", ungranted.id);
      if (error) {
        record("select sites (ungranted id) returns zero rows", false, `query errored: ${error.message}`);
      } else if (data.length === 0) {
        record("select sites (ungranted id) returns zero rows", true);
      } else {
        record(
          "select sites (ungranted id) returns zero rows",
          false,
          `leaked ${data.length} row(s) for the ungranted site ${ungranted.id}`,
        );
      }
    }

    // --- Assertion 3: select on site_snapshots for the ungranted site returns zero rows ---
    {
      const { data, error } = await scoped
        .from("site_snapshots")
        .select("id")
        .eq("site_id", ungranted.id);
      if (error) {
        record(
          "select site_snapshots (ungranted site) returns zero rows",
          false,
          `query errored: ${error.message}`,
        );
      } else if (data.length === 0) {
        record("select site_snapshots (ungranted site) returns zero rows", true);
      } else {
        record(
          "select site_snapshots (ungranted site) returns zero rows",
          false,
          `leaked ${data.length} snapshot row(s) for the ungranted site ${ungranted.id}`,
        );
      }
    }

    // --- Assertion 4: update on the granted site is rejected (read grant, not manage) ---
    // Supabase returns EITHER an error (with-check violation) OR a silently
    // empty result (using-clause filtered the row out of the update target,
    // 0 rows affected, no error) for a blocked write. Both are "rejected";
    // only a non-empty successful result is a leak. Assert the outcome.
    {
      const { data, error } = await scoped
        .from("sites")
        .update({ name: `${granted.name} (rls-verify probe)` })
        .eq("id", granted.id)
        .select("id,name");
      if (error) {
        if (isRlsRefusal(error)) {
          record("update on granted site is rejected", true, `refused: ${error.message}`);
        } else {
          record(
            "update on granted site is rejected",
            false,
            `errored for a reason other than RLS (code ${error.code ?? "?"}): ${error.message}`,
          );
        }
      } else if (!data || data.length === 0) {
        record("update on granted site is rejected", true, "0 rows affected");
      } else {
        mutatedSiteName = { id: granted.id, name: granted.name };
        record(
          "update on granted site is rejected",
          false,
          `update SUCCEEDED and returned ${data.length} row(s) -- a read-only grant can write sites`,
        );
      }
    }

    // --- Assertion 5: insert into site_snapshots for the granted site is rejected ---
    // This is the read-vs-manage split migration 0008 fixes: a 'read' grant
    // must not satisfy has_site_access(site_id, 'manage').
    {
      const { data, error } = await scoped
        .from("site_snapshots")
        .insert({ site_id: granted.id, payload: { probe: true } })
        .select("id");
      if (error) {
        if (isRlsRefusal(error)) {
          record("insert into site_snapshots (granted site) is rejected", true, `refused: ${error.message}`);
        } else {
          record(
            "insert into site_snapshots (granted site) is rejected",
            false,
            `errored for a reason other than RLS (code ${error.code ?? "?"}): ${error.message}`,
          );
        }
      } else if (!data || data.length === 0) {
        record("insert into site_snapshots (granted site) is rejected", true, "0 rows returned");
      } else {
        insertedSnapshotId = data[0]!.id as string;
        record(
          "insert into site_snapshots (granted site) is rejected",
          false,
          `insert SUCCEEDED -- a 'read' grant can write site_snapshots (the read/manage split is not enforced)`,
        );
      }
    }

    // --- Assertion 6: select on jobs returns zero rows (staff-only table) ---
    {
      const { data, error } = await scoped.from("jobs").select("id");
      if (error) {
        record("select jobs returns zero rows", false, `query errored: ${error.message}`);
      } else if (data.length === 0) {
        record("select jobs returns zero rows", true);
      } else {
        record(
          "select jobs returns zero rows",
          false,
          `leaked ${data.length} job row(s) to a client-role account`,
        );
      }
    }

    // =====================================================================
    // content_writer -- the 0009 regression this script could not catch
    // before, precisely because everything above only ever tests a
    // `client`. This user gets a role row and DELIBERATELY NO
    // user_site_access rows: content_writer holds sites.view_all, so it
    // sees every site with no grant at all. That is exactly the shape
    // has_site_access(site_id, 'manage')'s short-circuit on sites.view_all
    // (0007_rbac_functions.sql) got wrong for writes, and exactly the
    // shape has_site_grant_at_least() (0009_rbac_write_scope.sql) fixes:
    // it never consults sites.view_all, so a write policy built on it
    // alongside a real authorize() check cannot be bypassed by a
    // read-scope staff permission.
    // =====================================================================
    const cwEmail = `verify-rls-cw-${randomBytes(6).toString("hex")}@ocs-test.invalid`;
    const cwPassword = randomBytes(24).toString("base64"); // never logged, never hardcoded

    const { data: cwCreated, error: cwCreateErr } = await admin.auth.admin.createUser({
      email: cwEmail,
      password: cwPassword,
      email_confirm: true,
    });
    if (cwCreateErr) throw new Error(`could not create throwaway content_writer: ${cwCreateErr.message}`);
    cwUserId = cwCreated.user!.id;

    const { error: cwRoleErr } = await admin
      .from("user_roles")
      .insert({ user_id: cwUserId, role: "content_writer" });
    if (cwRoleErr) throw new Error(`could not seed content_writer user_roles: ${cwRoleErr.message}`);

    // No user_site_access insert here -- that absence IS the test. A
    // content_writer's only path to any site is sites.view_all.

    // Assertion CW-2 (revoke report) needs a real reports row to be
    // meaningful -- otherwise "0 rows affected" could just mean no report
    // exists, not a proven refusal. Seed one if none exists, same
    // reasoning as the jobs and site_snapshots fixtures above. If a report
    // already exists we reuse it and restore its share_token afterwards
    // instead of deleting someone else's row.
    const { data: existingReports, error: existingReportsErr } = await admin
      .from("reports")
      .select("id,share_token")
      .limit(1);
    if (existingReportsErr) throw new Error(`could not read reports: ${existingReportsErr.message}`);
    let cwReportId: string;
    let cwReportOriginalShareToken: string | null;
    if (existingReports && existingReports.length > 0) {
      cwReportId = existingReports[0]!.id as string;
      cwReportOriginalShareToken = existingReports[0]!.share_token as string | null;
    } else {
      const probeToken = `rls-verify-${randomBytes(8).toString("hex")}`;
      const { data: fixture, error: fixtureErr } = await admin
        .from("reports")
        .insert({
          site_id: granted.id,
          sections: ["overview"],
          storage_path: `rls-verification/${randomBytes(4).toString("hex")}.pdf`,
          share_token: probeToken,
        })
        .select("id,share_token")
        .single();
      if (fixtureErr) throw new Error(`could not seed reports fixture: ${fixtureErr.message}`);
      cwReportId = fixture!.id as string;
      cwReportOriginalShareToken = fixture!.share_token as string | null;
      cwSeededReportId = cwReportId;
    }

    // Assertion CW-3 (delete scan history) needs a real security_checks
    // row to be meaningful -- otherwise "0 rows affected" could just mean
    // the table is empty for every site, not a proven refusal. Same
    // reasoning again.
    const { data: existingChecks, error: existingChecksErr } = await admin
      .from("security_checks")
      .select("id")
      .limit(1);
    if (existingChecksErr) throw new Error(`could not read security_checks: ${existingChecksErr.message}`);
    let cwSecurityCheckId: string;
    if (existingChecks && existingChecks.length > 0) {
      cwSecurityCheckId = existingChecks[0]!.id as string;
    } else {
      const { data: fixture, error: fixtureErr } = await admin
        .from("security_checks")
        .insert({ site_id: granted.id, check_id: "rls_verification_probe", result: "pass" })
        .select("id")
        .single();
      if (fixtureErr) throw new Error(`could not seed security_checks fixture: ${fixtureErr.message}`);
      cwSecurityCheckId = fixture!.id as string;
      cwSeededSecurityCheckId = cwSecurityCheckId;
    }

    // Sign in as the throwaway content_writer with the ANON key -- same
    // client shape a real content_writer session gets.
    cwScoped = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
    const { error: cwSignInErr } = await cwScoped.auth.signInWithPassword({
      email: cwEmail,
      password: cwPassword,
    });
    if (cwSignInErr) throw new Error(`sign-in as throwaway content_writer failed: ${cwSignInErr.message}`);

    // --- Assertion CW-1: select on sites returns both sites (sites.view_all works) ---
    // Without this, every "refused" assertion below could pass vacuously
    // because the session JWT was never valid in the first place.
    {
      const { data, error } = await cwScoped.from("sites").select("id");
      const ids = new Set((data ?? []).map((r) => r.id));
      if (error) {
        record("content_writer: select sites returns every site", false, `query errored: ${error.message}`);
      } else if (ids.has(granted.id) && ids.has(ungranted.id)) {
        record("content_writer: select sites returns every site", true, `saw ${ids.size} site(s) via sites.view_all`);
      } else {
        record(
          "content_writer: select sites returns every site",
          false,
          `expected both ${granted.id} and ${ungranted.id} visible via sites.view_all, got [${[...ids].join(", ")}]`,
        );
      }
    }

    // --- Assertion CW-2: cannot revoke a report (headline 0009 case) ---
    // reports_write now requires authorize('reports.manage') AND
    // has_site_grant_at_least(site_id, 'manage'). content_writer holds
    // neither -- it has no reports.manage permission and no grant row at
    // all. Before 0009 this update succeeded via the sites.view_all
    // short-circuit alone, letting a content_writer null out share_token,
    // the exact mutation revokeReportAction() (src/app/.../reports actions)
    // refuses them at the application layer.
    {
      const { data, error } = await cwScoped
        .from("reports")
        .update({ share_token: null })
        .eq("id", cwReportId)
        .select("id,share_token");
      if (error) {
        if (isRlsRefusal(error)) {
          record("content_writer: revoke report (share_token -> null) is rejected", true, `refused: ${error.message}`);
        } else {
          record(
            "content_writer: revoke report (share_token -> null) is rejected",
            false,
            `errored for a reason other than RLS (code ${error.code ?? "?"}): ${error.message}`,
          );
        }
      } else if (!data || data.length === 0) {
        record("content_writer: revoke report (share_token -> null) is rejected", true, "0 rows affected");
      } else {
        cwLeakedReportShareToken = { id: cwReportId, shareToken: cwReportOriginalShareToken };
        record(
          "content_writer: revoke report (share_token -> null) is rejected",
          false,
          "update SUCCEEDED -- a content_writer (holds sites.view_all, but no reports.manage and no manage-level grant) revoked a report's share link",
        );
      }
    }

    // --- Assertion CW-3: cannot delete scan history ---
    // security_checks_write now requires authorize('security.run') AND
    // has_site_grant_at_least(site_id, 'manage'). content_writer holds
    // neither.
    {
      const { data, error } = await cwScoped
        .from("security_checks")
        .delete()
        .eq("id", cwSecurityCheckId)
        .select("id");
      if (error) {
        if (isRlsRefusal(error)) {
          record("content_writer: delete security_checks row is rejected", true, `refused: ${error.message}`);
        } else {
          record(
            "content_writer: delete security_checks row is rejected",
            false,
            `errored for a reason other than RLS (code ${error.code ?? "?"}): ${error.message}`,
          );
        }
      } else if (!data || data.length === 0) {
        record("content_writer: delete security_checks row is rejected", true, "0 rows affected");
      } else {
        record(
          "content_writer: delete security_checks row is rejected",
          false,
          `delete SUCCEEDED -- a content_writer wiped ${data.length} scan-history row(s) with no security.run permission or manage-level grant`,
        );
      }
    }

    // --- Assertion CW-4: cannot insert a forged inventory snapshot ---
    // site_snapshots_write now requires authorize('wp_toolkit.manage') AND
    // has_site_grant_at_least(site_id, 'manage'). content_writer holds
    // neither.
    {
      const { data, error } = await cwScoped
        .from("site_snapshots")
        .insert({ site_id: granted.id, payload: { rls_verification_probe: true } })
        .select("id");
      if (error) {
        if (isRlsRefusal(error)) {
          record("content_writer: insert forged site_snapshots row is rejected", true, `refused: ${error.message}`);
        } else {
          record(
            "content_writer: insert forged site_snapshots row is rejected",
            false,
            `errored for a reason other than RLS (code ${error.code ?? "?"}): ${error.message}`,
          );
        }
      } else if (!data || data.length === 0) {
        record("content_writer: insert forged site_snapshots row is rejected", true, "0 rows returned");
      } else {
        cwInsertedSiteSnapshotId = data[0]!.id as string;
        record(
          "content_writer: insert forged site_snapshots row is rejected",
          false,
          "insert SUCCEEDED -- a content_writer forged an inventory snapshot with no wp_toolkit.manage permission or manage-level grant",
        );
      }
    }

    // --- Assertion CW-5: insert into seo_snapshots is ALSO rejected --
    // and that is the correct, intended outcome, not a bug in this test.
    // content_writer DOES hold seo.run (0006_rbac_schema.sql's seed data)
    // -- that permission alone reads as "this role can run SEO scans". But
    // seo_snapshots_write requires authorize('seo.run') AND
    // has_site_grant_at_least(site_id, 'manage'), and this user has NO
    // user_site_access row on ANY site (by design -- see the top of this
    // section). 0009 requires both a permission and a real per-site grant
    // for every child-table write; holding the permission alone is not
    // enough. A reader expecting seo.run to be sufficient here would be
    // wrong -- that expectation is exactly what 0009 closes off.
    {
      const { data, error } = await cwScoped
        .from("seo_snapshots")
        .insert({ site_id: granted.id, source: "rls_verification_probe", payload: { probe: true } })
        .select("id");
      if (error) {
        if (isRlsRefusal(error)) {
          record(
            "content_writer: insert seo_snapshots is rejected (seo.run alone is not enough -- no manage-level grant)",
            true,
            `refused: ${error.message}`,
          );
        } else {
          record(
            "content_writer: insert seo_snapshots is rejected (seo.run alone is not enough -- no manage-level grant)",
            false,
            `errored for a reason other than RLS (code ${error.code ?? "?"}): ${error.message}`,
          );
        }
      } else if (!data || data.length === 0) {
        record(
          "content_writer: insert seo_snapshots is rejected (seo.run alone is not enough -- no manage-level grant)",
          true,
          "0 rows returned",
        );
      } else {
        cwInsertedSeoSnapshotId = data[0]!.id as string;
        record(
          "content_writer: insert seo_snapshots is rejected (seo.run alone is not enough -- no manage-level grant)",
          false,
          "insert SUCCEEDED -- a content_writer wrote seo_snapshots on the strength of seo.run alone, with no manage-level grant on the site",
        );
      }
    }
  } finally {
    // Clean up regardless of outcome -- a half-cleaned database after a
    // failed run is its own problem. Order: undo any accidental mutation,
    // remove fixtures, remove RBAC rows, then the auth user last (the RBAC
    // rows also cascade from it, so this is belt-and-suspenders).
    if (mutatedSiteName) {
      const { error } = await admin
        .from("sites")
        .update({ name: mutatedSiteName.name })
        .eq("id", mutatedSiteName.id);
      if (error) console.error(`cleanup: failed to restore site name: ${error.message}`);
    }
    if (insertedSnapshotId) {
      const { error } = await admin.from("site_snapshots").delete().eq("id", insertedSnapshotId);
      if (error) console.error(`cleanup: failed to delete probe snapshot: ${error.message}`);
    }
    if (seededJobId) {
      const { error } = await admin.from("jobs").delete().eq("id", seededJobId);
      if (error) console.error(`cleanup: failed to delete jobs fixture: ${error.message}`);
    }
    if (seededSnapshotId) {
      const { error } = await admin.from("site_snapshots").delete().eq("id", seededSnapshotId);
      if (error) console.error(`cleanup: failed to delete site_snapshots fixture: ${error.message}`);
    }
    if (userId) {
      const { error: grantDelErr } = await admin
        .from("user_site_access")
        .delete()
        .eq("user_id", userId);
      if (grantDelErr) console.error(`cleanup: failed to delete user_site_access: ${grantDelErr.message}`);

      const { error: roleDelErr } = await admin.from("user_roles").delete().eq("user_id", userId);
      if (roleDelErr) console.error(`cleanup: failed to delete user_roles: ${roleDelErr.message}`);

      const { error: userDelErr } = await admin.auth.admin.deleteUser(userId);
      if (userDelErr) console.error(`cleanup: failed to delete throwaway auth user: ${userDelErr.message}`);
    }

    // content_writer cleanup. Same ordering discipline as above: undo any
    // accidental mutation on a row we don't own first, then delete
    // fixtures/leaked rows we do own, then RBAC rows, then the auth user
    // last (cascade is belt-and-suspenders here too). None of these
    // fixture tables (reports, security_checks, site_snapshots,
    // seo_snapshots) reference each other -- only sites, which is never
    // deleted here -- so there is no ordering dependency between them,
    // only between "restore/delete the row" and "delete the user that
    // could no longer write it anyway".
    if (cwLeakedReportShareToken) {
      const { error } = await admin
        .from("reports")
        .update({ share_token: cwLeakedReportShareToken.shareToken })
        .eq("id", cwLeakedReportShareToken.id);
      if (error) console.error(`cleanup: failed to restore report share_token: ${error.message}`);
    }
    if (cwSeededReportId) {
      const { error } = await admin.from("reports").delete().eq("id", cwSeededReportId);
      if (error) console.error(`cleanup: failed to delete reports fixture: ${error.message}`);
    }
    if (cwSeededSecurityCheckId) {
      const { error } = await admin.from("security_checks").delete().eq("id", cwSeededSecurityCheckId);
      if (error) console.error(`cleanup: failed to delete security_checks fixture: ${error.message}`);
    }
    if (cwInsertedSiteSnapshotId) {
      const { error } = await admin.from("site_snapshots").delete().eq("id", cwInsertedSiteSnapshotId);
      if (error) console.error(`cleanup: failed to delete leaked site_snapshots row: ${error.message}`);
    }
    if (cwInsertedSeoSnapshotId) {
      const { error } = await admin.from("seo_snapshots").delete().eq("id", cwInsertedSeoSnapshotId);
      if (error) console.error(`cleanup: failed to delete leaked seo_snapshots row: ${error.message}`);
    }
    if (cwUserId) {
      // No user_site_access delete here -- this section deliberately never
      // inserts one. If a bug somehow created one anyway, the FK cascade
      // on auth.users deletion below still removes it.
      const { error: cwRoleDelErr } = await admin.from("user_roles").delete().eq("user_id", cwUserId);
      if (cwRoleDelErr) console.error(`cleanup: failed to delete content_writer user_roles: ${cwRoleDelErr.message}`);

      const { error: cwUserDelErr } = await admin.auth.admin.deleteUser(cwUserId);
      if (cwUserDelErr) {
        console.error(`cleanup: failed to delete throwaway content_writer auth user: ${cwUserDelErr.message}`);
      }
    }
  }

  const failed = assertions.filter((a) => !a.pass);
  console.log(`\n${assertions.length - failed.length}/${assertions.length} assertions passed`);
  if (failed.length > 0) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
