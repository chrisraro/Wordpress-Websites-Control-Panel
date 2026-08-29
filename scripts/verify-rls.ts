/**
 * Proves the RLS policies in supabase/migrations/0008_rls_scoped.sql actually
 * refuse cross-tenant access in the LIVE database. Every prior check in this
 * phase was structural (regexes over SQL text, mocked guards in Vitest) — a
 * policy that was never executed was never tested. This script executes real
 * queries, as a real signed-in `client`-role user, against real Postgres.
 *
 * Deliberately NOT part of `npm test` (not a Vitest file): it creates a
 * throwaway Supabase Auth user, mutates RBAC tables, and needs live
 * credentials. Run it manually, deliberately:
 *
 *   npm run verify:rls
 *   (or: node --experimental-strip-types scripts/verify-rls.ts)
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
 * SUPABASE_SERVICE_ROLE_KEY in .env.local (same file the app itself reads).
 *
 * The database needs at least two rows in `sites`: the throwaway user is
 * granted exactly one (read-level), and every assertion about the *other*
 * site proves the grant boundary rather than an empty table.
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
