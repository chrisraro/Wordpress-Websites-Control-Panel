"use server";

import { revalidatePath } from "next/cache";
import { listSitesForViewer } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { pendingPluginUpdates } from "@/services/inventory/types";
import { enqueueJob, enqueueBatch } from "@/services/jobs/service";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, isDenied } from "@/lib/authz/server";
import { canAccessSite } from "@/lib/authz/decide";
import { siteEnvironment } from "@/services/sites/portfolio";
import type { SiteEnvironment } from "@/services/sites/types";
import { friendlySiteError } from "@/lib/mcp/errors";
import type { JobType } from "@/services/jobs/types";
import type { ManageResult } from "../sites/[id]/action-form";

/**
 * Enqueues a snapshot_refresh for every site the caller may see and manage —
 * the "Refresh all inventory" control on the dashboard. Enqueue only: a
 * dozen sites of MCP + PHP work cannot run inside one request, so this
 * always drops jobs on the queue for the per-minute cron to drain, exactly
 * like the nightly fan-out (src/app/api/cron/enqueue/route.ts) and the
 * single-site refreshInventoryAction (../sites/[id]/manage-actions.ts).
 *
 * Scoped to one environment, because the dashboard is now scoped to one.
 * A control sitting under a "Staging" tab that quietly also touched the
 * twelve production sites would be precisely the mistake PRODUCT.md names as
 * the expensive one this product can cause — and the button's own
 * confirmation would have been counting sites the reader could not see.
 * The environment is bound by the page rather than posted in the form: it is
 * the caller's context, not user input, and nothing in the browser should be
 * able to widen the blast radius of a bulk action.
 */
export async function refreshAllInventoryAction(
  env: SiteEnvironment,
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
    (s) =>
      s.status !== "disabled" &&
      siteEnvironment(s) === env &&
      canAccessSite(viewer, s.id, "manage"),
  );

  if (targets.length === 0) {
    return { ok: false, error: `No ${env} sites are eligible for a refresh.` };
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
    return { ok: false, error: friendlySiteError(e) || "Could not dismiss the failed jobs" };
  }
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Queues "update every plugin that has an update" for every site in one
 * environment — the dashboard's counterpart to the single-site "Update all"
 * on a site's Plugins tab.
 *
 * Scoped to one environment for the same reason refreshAllInventoryAction is,
 * only more so: this one *writes to live client websites*. A control that
 * silently reached from the Staging tab into twelve production sites would be
 * the worst version of the mistake PRODUCT.md names, and unlike a refresh it
 * could not be undone by running it again.
 *
 * Enqueue only, one job per site, all under a single batch_id so the existing
 * batch page can show which sites finished and which failed. Updating a dozen
 * WordPress installs is minutes of work; it cannot happen inside a request,
 * and pretending otherwise is how you get a half-updated fleet and a
 * timed-out browser tab.
 */
export async function updateAllPluginsAction(
  env: SiteEnvironment,
  _prevState?: unknown,
  _formData?: FormData,
): Promise<ManageResult> {
  const user = await requireUser();
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const viewer = gate;

  const db = createServiceSupabase();
  const jobs = supabaseJobsRepo(db);
  const sites = await listSitesForViewer(
    { repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs },
    viewer,
  );
  const candidates = sites.filter(
    (s) =>
      s.status !== "disabled" &&
      siteEnvironment(s) === env &&
      canAccessSite(viewer, s.id, "manage"),
  );

  // Eligibility is judged from the stored snapshot — the same numbers the
  // operator was looking at when they pressed the button. Each job re-checks
  // live state when it runs, so a site that updated itself in the meantime
  // reports "Nothing to update" rather than failing.
  const snapshots = supabaseSnapshotsRepo(db);
  const withUpdates: string[] = [];
  let alreadyQueued = 0;
  for (const site of candidates) {
    const snap = await snapshots.latestSnapshot(site.id);
    if (!snap || pendingPluginUpdates(snap.payload) === 0) continue;
    // A second press while the first batch is still draining must not queue
    // a second pass over the same site: two concurrent update runs on one
    // WordPress install is how you corrupt a plugin directory.
    if (await jobs.pendingExists("update_all_plugins", site.id)) {
      alreadyQueued++;
      continue;
    }
    withUpdates.push(site.id);
  }

  if (withUpdates.length === 0) {
    return {
      ok: false,
      error: alreadyQueued > 0
        ? "Already queued — those sites have plugin updates pending from an earlier run."
        : `No ${env} site has a plugin update waiting.`,
    };
  }

  const { batchId, count } = await enqueueBatch(
    jobs, "update_all_plugins", withUpdates, { actor: user.id },
  );
  revalidatePath("/dashboard");
  const siteWord = (n: number) => `${n} site${n === 1 ? "" : "s"}`;
  return {
    ok: true,
    // "Queued", never "updated": nothing has run yet.
    message: alreadyQueued > 0
      ? `Queued plugin updates for ${siteWord(count)} (${alreadyQueued} already had a run pending).`
      : `Queued plugin updates for ${siteWord(count)}.`,
    href: `/marketplace/batches/${batchId}`,
  };
}
