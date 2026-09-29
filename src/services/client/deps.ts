import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseClientEvidenceDeps } from "./repo";
import type { ClientEvidenceDeps } from "./summary";

/**
 * The client home's evidence readers, for a page.
 *
 * Dashboard pages may not create a service-role client themselves
 * (tests/authz-read-path.test.ts): their reads must stay on readDbFor's
 * RLS-governed client. The one read here that cannot -- a count of
 * maintenance actions in activity_log, which RLS keeps staff-only -- is
 * built in the service layer instead, where its scope is pinned by
 * tests/client-evidence-repo.test.ts (head-only counts, one site at a time)
 * and tests/client-evidence-load.test.ts (never for an ungranted site).
 *
 * @param viewerDb the client from readDbFor(viewer); every other read uses it.
 */
export function clientEvidenceDeps(viewerDb: SupabaseClient): ClientEvidenceDeps {
  return supabaseClientEvidenceDeps(viewerDb, createServiceSupabase());
}
