"use server";

import { revalidatePath } from "next/cache";
import { listSitesForViewer } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { enqueueJob } from "@/services/jobs/service";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, isDenied } from "@/lib/authz/server";
import { canAccessSite } from "@/lib/authz/decide";
import type { JobType } from "@/services/jobs/types";
import type { ManageResult } from "../sites/[id]/action-form";

/**
 * Enqueues a snapshot_refresh for every site the caller may see and manage —
 * the "Refresh all inventory" control on the dashboard. Enqueue only: a
 * dozen sites of MCP + PHP work cannot run inside one request, so this
 * always drops jobs on the queue for the per-minute cron to drain, exactly
 * like the nightly fan-out (src/app/api/cron/enqueue/route.ts) and the
 * single-site refreshInventoryAction (../sites/[id]/manage-actions.ts).
 */
export async function refreshAllInventoryAction(
  _prevState?: ManageResult,
  _formData?: FormData,
): Promise<ManageResult> {
  await requireUser();
  // Same dual check as refreshInventoryAction: a permission says what may be
  // done, a site grant says on which sites. There is no single siteId here,
  // so instead of one checkSiteAccess call, every candidate site is held to
  // the same "manage" bar below (canAccessSite(..., "manage")) rather than
  // trusting listSitesForViewer's read-level visibility alone — a client
  // with only a `read` grant must not have their sites silently refreshed.
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const viewer = gate;

  const db = createServiceSupabase();
  const jobs = supabaseJobsRepo(db);
  const sites = await listSitesForViewer(
    { repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs },
    viewer,
  );
  // Disabled sites are skipped, matching the nightly fan-out
  // (cron/enqueue/route.ts's `active = sites.filter(s => s.status !== "disabled")`)
  // — nobody should contact a connection nobody trusts.
  const targets = sites.filter(
    (s) => s.status !== "disabled" && canAccessSite(viewer, s.id, "manage"),
  );

  if (targets.length === 0) {
    return { ok: false, error: "No sites are eligible for a refresh." };
  }

  let queued = 0;
  for (const site of targets) {
    // dedupe: true, same as every other enqueueJob call — a second click
    // while jobs from the first are still pending must not double the queue.
    const job = await enqueueJob(jobs, "snapshot_refresh", site.id, {}, { dedupe: true });
    if (job) queued++;
  }

  revalidatePath("/dashboard");

  // Honest result: "queued", never "refreshed" — the jobs have not run yet,
  // they've only been placed on the queue the per-minute cron drains. If
  // dedupe skipped some (already pending from a previous click or tonight's
  // fan-out), the reported count reflects what was actually enqueued now,
  // not how many sites were considered.
  const siteWord = (n: number) => `${n} site${n === 1 ? "" : "s"}`;
  const message =
    queued === 0
      ? "Already queued — every eligible site already has a refresh pending."
      : queued === targets.length
        ? `Queued inventory refresh for ${siteWord(queued)}.`
        : `Queued inventory refresh for ${siteWord(queued)} (${targets.length - queued} already had one pending).`;
  return { ok: true, message };
}

/**
 * Clears the "N failed" alert for a site-less job type on the dashboard's
 * system-health panel — the global counterpart of
 * dismissFailedGeoGridRunsAction (../sites/[id]/geogrid-actions.ts). Gated on
 * `queue.process`, not a site permission: these jobs (e.g. `vuln_feed_refresh`)
 * have no site to check access against, and `queue.process` is already the
 * permission that means "you are responsible for the queue" — the same one
 * that gates draining it. This dismisses only; the job rows and their
 * `last_error` are left exactly as they are, so a resolved failure can stop
 * nagging without losing the record of what happened.
 */
export async function dismissGlobalFailedJobsAction(
  jobType: JobType,
  _prevState?: ManageResult,
  _formData?: FormData,
): Promise<ManageResult> {
  await requireUser();
  const gate = await checkPermission("queue.process");
  if (isDenied(gate)) return gate;

  const db = createServiceSupabase();
  try {
    await supabaseJobsRepo(db).dismissFailed(null, jobType);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not dismiss the failed jobs" };
  }
  revalidatePath("/dashboard");
  return { ok: true };
}
