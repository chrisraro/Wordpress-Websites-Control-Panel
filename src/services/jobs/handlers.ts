import type { SupabaseClient } from "@supabase/supabase-js";
import { NonRetryableError, type JobHandlers } from "@/services/jobs/service";
import { can, canAccessSite, type Viewer } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";
import { refreshSnapshot } from "@/services/inventory/service";
import { supabaseAdminUsersRepo, supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { securityScan, refreshVulnFeed, isFinalScanAttempt } from "@/services/security/scan";
import { installPlugin, type InstallSource } from "@/services/marketplace/install";
import { installTheme } from "@/services/themes/install";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { seoScan } from "@/services/seo/scan";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { runGeoGrid } from "@/services/geogrid/run";
import { stubProvider } from "@/services/geogrid/providers/stub";
import { createN8nProvider } from "@/services/geogrid/providers/n8n";
import { getOptionalEnv } from "@/lib/env";
import { generateReport } from "@/services/reports/generate";
import { supabaseReportsRepo, supabaseReportStorage } from "@/services/reports/repo";
import { parseSections, REPORT_SECTIONS } from "@/services/reports/types";
import { manageSite } from "@/services/manage/service";
import { toManageAction } from "@/services/bulk/service";
import type { BulkJobPayload } from "@/services/bulk/types";
import { hardenSite, hardeningPlan } from "@/services/security/harden";
import { backupPolicyOf, gateOnBackup, type BackupJobFields } from "@/services/backup/gate";
import { BACKUP_TIMEOUT_MS } from "@/services/backup/updraft";
import { setupUpdraft } from "@/services/backup/setup";

interface PluginInstallPayload {
  source: { kind: "wporg"; slug: string } | { kind: "upload"; path: string };
  activate: boolean;
  actor: string;
  /**
   * Multi-site theme installs fan out through this same job type — themes
   * and plugins both install "on N sites at once" the same way, so a second
   * job type would just duplicate the batching logic. This field is the only
   * thing that tells the handler which wordpress.org API and which upgrader
   * (`Plugin_Upgrader` vs `Theme_Upgrader`) to use. Omitted = plugin, so jobs
   * already queued before this field existed keep behaving as plugin installs.
   */
  target?: "plugin" | "theme";
}

/**
 * The payload the UI/API read (BulkJobPayload) doesn't carry who queued the
 * batch — that's for the handler alone, so it rides along as an extra field
 * rather than widening the shared contract. Same idea as PluginInstallPayload
 * above: the job's actual payload is a superset of what other code needs.
 */
interface BulkManagePayload extends BulkJobPayload {
  actor: string;
}

export type InstallKind = "plugin" | "theme";

/**
 * Pure dispatch decision for the plugin_install handler: which installer to
 * run and which storage bucket an uploaded package's signed URL comes from.
 * Extracted so the theme/plugin branch — and its backward-compatible
 * "no target field at all" default to plugin — has direct test coverage
 * without standing up the handler's full Supabase + MCP scaffolding.
 */
export function resolveInstallKind(target: PluginInstallPayload["target"]): {
  kind: InstallKind;
  bucket: "plugins" | "themes";
} {
  const kind: InstallKind = target === "theme" ? "theme" : "plugin";
  return { kind, bucket: kind === "theme" ? "themes" : "plugins" };
}

/**
 * Loads a user's current authority; null when they have none. Throws a
 * plain (retryable) Error when it cannot tell -- a database blip must put
 * the job back on the retry ladder, not fail it as if access were revoked.
 */
export type ActorLoader = (userId: string) => Promise<Viewer | null>;

/**
 * loadViewer fails closed (null) on a read error as well as on "no role",
 * which is right for a page but would turn a transient outage into a
 * permanent job failure here. So probe the role row first on the same
 * client and throw on an error; only then ask loadViewer. Imported lazily:
 * src/lib/authz/server.ts is `server-only` and pulls in Next.js, which this
 * module's other importers (and tests) should not need.
 */
function defaultActorLoader(db: SupabaseClient): ActorLoader {
  return async (userId) => {
    // Same three reads loadViewer makes; any error means "cannot tell".
    const probes = await Promise.all([
      db.from("user_roles").select("role").eq("user_id", userId).maybeSingle(),
      db.from("user_permission_overrides").select("permission").eq("user_id", userId).limit(1),
      db.from("user_site_access").select("site_id").eq("user_id", userId).limit(1),
    ]);
    const failed = probes.find((p) => p.error);
    if (failed?.error) {
      throw new Error(`could not read the queuing user's access (${failed.error.message}); will retry`);
    }
    const { loadViewer } = await import("@/lib/authz/server");
    return loadViewer(userId, null);
  };
}

/**
 * What every enqueuing path for plugin_install, bulk_manage,
 * update_all_plugins and harden requires: the marketplace install, bulk and
 * fleet actions in src/app/(dashboard) and the MCP fleet tool all check
 * wp_toolkit.manage plus a manage grant on each site.
 */
const ACT_PERMISSION: AppPermission = "wp_toolkit.manage";

/**
 * Re-checks, at run time, that the user who queued a job may still do it.
 *
 * A job can wait minutes (or, on the retry ladder, longer) between enqueue
 * and run; authority checked only at enqueue would let a revoked user's
 * queued work still act on a live site. Refusal is NonRetryableError: a
 * retry a minute later would be refused the same way. A user who is gone or
 * has no role is refused too. A loader that throws (it could not read the
 * user's access) propagates as an ordinary, retryable error.
 */
export async function assertActorAuthorized(
  loadActor: ActorLoader, actor: string, siteId: string, jobType: string,
): Promise<void> {
  const viewer = await loadActor(actor);
  if (!viewer || !can(viewer, ACT_PERMISSION) || !canAccessSite(viewer, siteId, "manage")) {
    throw new NonRetryableError(
      `actor no longer authorized to run ${jobType} on this site ` +
      `(requires ${ACT_PERMISSION} and a manage grant); the job was not run`,
    );
  }
}

/**
 * Newest backup_requested_at among the site's live update jobs within the
 * backup timeout, so every job of one bulk action waits on the same backup.
 */
async function latestSiteBackupRequest(db: SupabaseClient, siteId: string): Promise<number | null> {
  const { data, error } = await db.from("jobs").select("payload")
    .eq("site_id", siteId).in("status", ["pending", "running"]).is("cancelled_at", null)
    .not("payload->backup_requested_at", "is", null);
  if (error) throw new Error(`could not read sibling backup requests (${error.message}); will retry`);
  const cutoff = Date.now() - BACKUP_TIMEOUT_MS;
  const times = (data ?? [])
    .map((r) => Number((r.payload as { backup_requested_at?: unknown }).backup_requested_at))
    .filter((t) => Number.isFinite(t) && t >= cutoff);
  return times.length ? Math.max(...times) : null;
}

export interface JobHandlerOptions {
  /** How the queued actor's current authority is read; injectable for tests. */
  loadActor?: ActorLoader;
}

export function buildJobHandlers(db: SupabaseClient, opts: JobHandlerOptions = {}): JobHandlers {
  const loadActor = opts.loadActor ?? defaultActorLoader(db);
  const sites = supabaseSitesRepo(db);
  const snapshots = supabaseSnapshotsRepo(db);
  const adminUsers = supabaseAdminUsersRepo(db);
  const security = supabaseSecurityRepo(db);
  const jobs = supabaseJobsRepo(db);
  const seo = supabaseSeoRepo(db);
  const backupGate = {
    sites, mcp: createSiteMcpClient,
    siteBackupRequestedAt: (siteId: string) => latestSiteBackupRequest(db, siteId),
  };

  return {
    snapshot_refresh: async ({ job }) => {
      if (!job.site_id) throw new Error("snapshot_refresh requires site_id");
      await refreshSnapshot({ sites, snapshots, adminUsers, mcp: createSiteMcpClient }, job.site_id);
    },
    security_scan: async ({ job }) => {
      if (!job.site_id) throw new Error("security_scan requires site_id");
      await securityScan(
        { sites, snapshots, adminUsers, security, mcp: createSiteMcpClient }, job.site_id,
        // Only the ladder's last attempt counts toward 'degraded' (see isFinalScanAttempt).
        { recordFailure: isFinalScanAttempt(job.attempts) },
      );
    },
    vuln_feed_refresh: async () => {
      // Always refetches. The freshness guard that used to live behind
      // `allowSkip` here reported success on a partially-written feed and was
      // removed; see refreshVulnFeed's own comment for the incident.
      await refreshVulnFeed(security);
    },
    seo_scan: async ({ job }) => {
      if (!job.site_id) throw new Error("seo_scan requires site_id");
      await seoScan({ sites, seo, mcp: createSiteMcpClient }, job.site_id);
    },
    plugin_install: async ({ job }) => {
      if (!job.site_id) throw new Error("plugin_install requires site_id");
      const p = job.payload as unknown as PluginInstallPayload;
      if (!p?.source || typeof p.actor !== "string") throw new Error("plugin_install payload malformed");
      // Only wordpress.org slugs and our own signed uploads are installable;
      // a url-kind payload would hand the site an arbitrary download URL.
      if (p.source.kind !== "wporg" && p.source.kind !== "upload") {
        throw new Error("plugin_install source kind not allowed");
      }
      await assertActorAuthorized(loadActor, p.actor, job.site_id, "plugin_install");
      const { kind, bucket } = resolveInstallKind(p.target);
      const isTheme = kind === "theme";
      let source: InstallSource;
      if (p.source.kind === "upload") {
        const { data, error } = await db.storage.from(bucket).createSignedUrl(p.source.path, 3600);
        if (error || !data?.signedUrl) {
          throw new Error(`Could not sign uploaded ${isTheme ? "theme" : "plugin"} URL: ${error?.message ?? "unknown"}`);
        }
        source = { kind: "url", url: data.signedUrl };
      } else {
        source = { kind: "wporg", slug: p.source.slug };
      }
      const result = isTheme
        ? await installTheme(
            { sites, jobs, mcp: createSiteMcpClient }, job.site_id, p.actor, source, Boolean(p.activate),
          )
        : await installPlugin(
            { sites, jobs, mcp: createSiteMcpClient }, job.site_id, p.actor, source, Boolean(p.activate),
          );
      if (!result.ok) throw new Error(result.error ?? "Install failed");
    },
    geogrid_run: async ({ job }) => {
      const p = job.payload as { config_id?: string; keyword?: string };
      if (!p?.config_id || !p?.keyword) throw new Error("geogrid_run payload malformed");
      const { awaiting } = await runGeoGrid(
        {
          geogrid: supabaseGeoGridRepo(db),
          providers: { stub: stubProvider, n8n: createN8nProvider() },
          appUrl: getOptionalEnv("APP_URL") ?? "http://localhost:3000",
        },
        job.id, job.attempts, p.config_id, p.keyword,
      );
      if (awaiting) return { awaitingCallback: true };
    },
    report_generate: async ({ job }) => {
      if (!job.site_id) throw new Error("report_generate requires site_id");
      const p = job.payload as { sections?: unknown; period_days?: unknown; manual?: unknown };
      const sections = parseSections(p.sections);
      await generateReport(
        {
          sites, snapshots, security, seo,
          geogrid: supabaseGeoGridRepo(db),
          reports: supabaseReportsRepo(db),
          storage: supabaseReportStorage(db),
        },
        job.site_id,
        sections.length > 0 ? sections : REPORT_SECTIONS,
        Number(p.period_days) > 0 ? Number(p.period_days) : 30,
        // Monthly runs are auto (no share link until asked for); a report
        // someone queued by hand (the MCP tool marks it manual) gets one.
        p.manual !== true,
      );
    },
    bulk_manage: async ({ job }) => {
      if (!job.site_id) throw new Error("bulk_manage requires a site_id");
      const p = job.payload as unknown as BulkManagePayload;
      if (!p?.kind || !p?.target || !p?.id || typeof p.actor !== "string") {
        throw new Error("bulk_manage payload malformed");
      }
      const action = toManageAction(p.kind, p.target, p.id);
      await assertActorAuthorized(loadActor, p.actor, job.site_id, "bulk_manage");
      // Updates wait for a pre-update backup (or the operator's explicit
      // "without a backup"); activate/deactivate/delete do not.
      if (p.kind === "update") {
        await gateOnBackup(backupGate, job.site_id, job.payload as BackupJobFields);
      }
      const result = await manageSite(
        { sites, jobs, mcp: createSiteMcpClient }, job.site_id, p.actor, action,
      );
      // Throwing puts the job on the retry ladder; a failing item must never
      // abort its siblings, which are separate jobs.
      if (!result.ok) {
        // A slow bulk run can be killed by the platform's function time
        // limit mid-item. The job is left `running`, gets re-claimed ~15
        // minutes later by the retry ladder, and re-runs — but the delete
        // already succeeded, so the item is already gone. The PHP in
        // services/manage/service.ts then returns exactly "Plugin is not
        // installed" / "Theme is not installed" for delete_plugin/
        // delete_theme. Without this, that retry turns a *successful*
        // delete into a reported failure, and the operator concludes the
        // plugin/theme is still on the site when it is not. Scoped to
        // delete kinds only: for every other kind, "not installed" is a
        // genuine failure (e.g. the item was deleted out from under an
        // update/activate job) and must still throw.
        const deletedAlready = p.kind === "delete" && (
          (p.target === "plugin" && result.error === "Plugin is not installed") ||
          (p.target === "theme" && result.error === "Theme is not installed")
        );
        if (!deletedAlready) throw new Error(result.error ?? "Bulk action failed");
      }
    },
    /**
     * Every plugin with an available update, on one site.
     *
     * A sibling of bulk_manage rather than a variant of it: bulk_manage
     * carries the id of a specific item, and there is no such id here. Which
     * plugins get updated is decided by the site when the job runs, from its
     * own update transient — deliberately, because the alternative is to
     * freeze a list at enqueue time and then update plugins against
     * fortnight-old inventory.
     *
     * One job per site, all sharing a batch_id, so a failure on one site
     * leaves the others to finish and the batch page can show which.
     */
    update_all_plugins: async ({ job }) => {
      if (!job.site_id) throw new Error("update_all_plugins requires a site_id");
      const p = job.payload as { actor?: unknown };
      if (typeof p?.actor !== "string") {
        throw new Error("update_all_plugins payload malformed");
      }
      await assertActorAuthorized(loadActor, p.actor, job.site_id, "update_all_plugins");
      // No update pending per the latest inventory: nothing will change, so
      // do not ask the site for a backup first. manageSite still checks live.
      const fields = job.payload as BackupJobFields;
      if (backupPolicyOf(fields) === "required") {
        const latest = await snapshots.latestSnapshot(job.site_id);
        const nothingToUpdate = latest !== null && latest.payload.plugins.every((pl) => pl.update !== "available");
        if (!nothingToUpdate) await gateOnBackup(backupGate, job.site_id, fields);
      }
      const result = await manageSite(
        { sites, jobs, mcp: createSiteMcpClient }, job.site_id, p.actor,
        { kind: "update_all_plugins" },
      );
      // "Nothing to update" is a success in the PHP (see manage/service.ts):
      // a site that raced ahead of the inventory is not a failed job.
      if (!result.ok) throw new Error(result.error ?? "Plugin updates failed");
    },
    backup_setup: async ({ job }) => {
      if (!job.site_id) throw new Error("backup_setup requires a site_id");
      const p = job.payload as { actor?: unknown };
      if (typeof p?.actor !== "string") throw new Error("backup_setup payload malformed");
      await assertActorAuthorized(loadActor, p.actor, job.site_id, "backup_setup");
      // Succeeds with Drive still unauthorized: the plugin, destination and
      // schedule are in place, and the Google sign-in is a person's step
      // (recorded in the activity log as driveAuthorized: false).
      await setupUpdraft({ sites, jobs, mcp: createSiteMcpClient }, job.site_id, p.actor);
    },
    harden: async ({ job }) => {
      if (!job.site_id) throw new Error("harden requires a site_id");
      const p = job.payload as { actor?: unknown };
      if (typeof p?.actor !== "string") throw new Error("harden payload malformed");
      await assertActorAuthorized(loadActor, p.actor, job.site_id, "harden");
      const latest = await security.latestChecks(job.site_id);
      const plan = latest ? hardeningPlan(latest.checks) : [];
      // A site with nothing to fix is a success, not a failure: the fleet
      // action filters these out, but a scan between queueing and running
      // can legitimately clear the list.
      if (plan.length === 0) return;
      const out = await hardenSite({ sites, mcp: createSiteMcpClient }, job.site_id, p.actor, plan);
      // Rescan so the grade reflects the new state without waiting for 02:00.
      await securityScan(
        { sites, snapshots, adminUsers, security, mcp: createSiteMcpClient }, job.site_id,
        // Only the ladder's last attempt counts toward 'degraded' (see isFinalScanAttempt).
        { recordFailure: isFinalScanAttempt(job.attempts) },
      );
      const failed = out.results.filter((r) => r.outcome === "failed");
      if (out.error || failed.length) {
        throw new Error(out.error ?? failed.map((f) => `${f.fix}: ${f.reason ?? "failed"}`).join("; "));
      }
    },
  };
}
