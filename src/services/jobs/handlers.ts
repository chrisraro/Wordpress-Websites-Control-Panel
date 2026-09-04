import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobHandlers } from "@/services/jobs/service";
import { refreshSnapshot } from "@/services/inventory/service";
import { supabaseAdminUsersRepo, supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { securityScan, refreshVulnFeed } from "@/services/security/scan";
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

interface PluginInstallPayload {
  source: InstallSource | { kind: "upload"; path: string };
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

export function buildJobHandlers(db: SupabaseClient): JobHandlers {
  const sites = supabaseSitesRepo(db);
  const snapshots = supabaseSnapshotsRepo(db);
  const adminUsers = supabaseAdminUsersRepo(db);
  const security = supabaseSecurityRepo(db);
  const jobs = supabaseJobsRepo(db);
  const seo = supabaseSeoRepo(db);

  return {
    snapshot_refresh: async ({ job }) => {
      if (!job.site_id) throw new Error("snapshot_refresh requires site_id");
      await refreshSnapshot({ sites, snapshots, adminUsers, mcp: createSiteMcpClient }, job.site_id);
    },
    security_scan: async ({ job }) => {
      if (!job.site_id) throw new Error("security_scan requires site_id");
      await securityScan({ sites, snapshots, adminUsers, security, mcp: createSiteMcpClient }, job.site_id);
    },
    vuln_feed_refresh: async ({ job }) => {
      // `processJobs` increments `attempts` on claim (see
      // supabase/migrations/0002_jobs_claim.sql), so attempts === 1 is this
      // job's first try and attempts > 1 is a retry of a run that just threw.
      // The freshness guard exists only to suppress duplicate work from a
      // double-trigger (two schedulers firing the same night); a retry is
      // recovery from THIS job's own failure, not duplicate work, and must
      // always refetch. If it didn't, a `replaceFeed` that dies partway
      // through its chunked upsert (leaving the un-upserted tail on
      // yesterday's rows, but `updated_at` fresh on everything it did write)
      // would cause the retry to see a fresh timestamp, skip, and report
      // success — silently leaving the feed permanently incomplete for the
      // night. Do not "simplify" this back to an unconditional allowSkip.
      await refreshVulnFeed(security, undefined, { allowSkip: job.attempts <= 1 });
    },
    seo_scan: async ({ job }) => {
      if (!job.site_id) throw new Error("seo_scan requires site_id");
      await seoScan({ sites, seo, mcp: createSiteMcpClient }, job.site_id);
    },
    plugin_install: async ({ job }) => {
      if (!job.site_id) throw new Error("plugin_install requires site_id");
      const p = job.payload as unknown as PluginInstallPayload;
      if (!p?.source || typeof p.actor !== "string") throw new Error("plugin_install payload malformed");
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
        source = p.source;
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
      const p = job.payload as { sections?: unknown; period_days?: unknown };
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
        true,
      );
    },
    bulk_manage: async ({ job }) => {
      if (!job.site_id) throw new Error("bulk_manage requires a site_id");
      const p = job.payload as unknown as BulkManagePayload;
      if (!p?.kind || !p?.target || !p?.id || typeof p.actor !== "string") {
        throw new Error("bulk_manage payload malformed");
      }
      const action = toManageAction(p.kind, p.target, p.id);
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
      const result = await manageSite(
        { sites, jobs, mcp: createSiteMcpClient }, job.site_id, p.actor,
        { kind: "update_all_plugins" },
      );
      // "Nothing to update" is a success in the PHP (see manage/service.ts):
      // a site that raced ahead of the inventory is not a failed job.
      if (!result.ok) throw new Error(result.error ?? "Plugin updates failed");
    },
  };
}
