import { listSitesForViewer, type SitesDeps } from "@/services/sites/service";
import { siteEnvironment } from "@/services/sites/portfolio";
import { canAccessSite, type Viewer } from "@/lib/authz/decide";
import { pendingPluginUpdates, type InventoryPayload } from "@/services/inventory/types";
import type { JobsRepo } from "@/services/jobs/repo";
import type { SiteEnvironment, SiteRow } from "@/services/sites/types";

/**
 * The one read this needs off the snapshots repo. Deliberately narrower than
 * `SnapshotsRepo` (src/services/inventory/repo.ts), which also carries
 * `insertSnapshot` -- the same "read deps" pattern as
 * `src/mcp/context.ts`'s `InventoryReadDeps`, and what lets the MCP fleet
 * tool pass its own `ctx.inventory` (typed to exactly this) straight through
 * without widening it.
 */
export interface FleetSnapshotsDeps {
  latestSnapshot(siteId: string): Promise<{ payload: InventoryPayload; taken_at: string } | null>;
}

export interface FleetPlanDeps {
  sites: SitesDeps;
  snapshots: FleetSnapshotsDeps;
  jobs: JobsRepo;
}

export interface FleetPluginUpdatePlan {
  /** Sites to enqueue: manageable, in-environment, enabled, with a plugin
   * update waiting, and no run already queued. */
  eligible: SiteRow[];
  /** Otherwise-eligible sites skipped because a run is already pending. */
  alreadyQueued: SiteRow[];
  /** Otherwise-eligible sites skipped because they have no plugin update
   * waiting (never inventoried counts as "nothing waiting"). */
  noUpdates: SiteRow[];
}

/**
 * Decides which sites `update_all_plugins_fleet` may enqueue, and why the
 * rest were left out.
 *
 * Mirrors `updateAllPluginsAction`'s candidate logic
 * (src/app/(dashboard)/dashboard/actions.ts) exactly -- disabled sites out,
 * one environment only, a `manage` grant (not merely `read`) required, a
 * plugin update actually waiting per the latest snapshot, and no duplicate
 * run already queued for the site -- so the MCP tool and the dashboard
 * button apply identical rules to identical inputs. Extracted here rather
 * than imported from the dashboard action because that file is a Next.js
 * "use server" action module the MCP tool layer must not import from; the
 * two implementations are intentionally parallel and this project accepts
 * that duplication rather than reach across that boundary. See
 * task-10b-report.md for the note this task was asked to leave for review.
 *
 * Read-only: nothing is enqueued here. The caller (the MCP tool) decides
 * whether and when to act on the plan.
 */
export async function planFleetPluginUpdate(
  deps: FleetPlanDeps, viewer: Viewer, env: SiteEnvironment,
): Promise<FleetPluginUpdatePlan> {
  const sites = await listSitesForViewer(deps.sites, viewer);
  const candidates = sites.filter(
    (s) => s.status !== "disabled" && siteEnvironment(s) === env && canAccessSite(viewer, s.id, "manage"),
  );

  const eligible: SiteRow[] = [];
  const alreadyQueued: SiteRow[] = [];
  const noUpdates: SiteRow[] = [];
  for (const site of candidates) {
    const snap = await deps.snapshots.latestSnapshot(site.id);
    if (!snap || pendingPluginUpdates(snap.payload) === 0) {
      noUpdates.push(site);
      continue;
    }
    // A second run queued for a site that already has one pending is how you
    // corrupt a plugin directory with two concurrent update passes -- same
    // guard as updateAllPluginsAction.
    if (await deps.jobs.pendingExists("update_all_plugins", site.id)) {
      alreadyQueued.push(site);
      continue;
    }
    eligible.push(site);
  }
  return { eligible, alreadyQueued, noUpdates };
}
