import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobHandlers } from "@/services/jobs/service";
import { refreshSnapshot } from "@/services/inventory/service";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { securityScan, refreshVulnFeed } from "@/services/security/scan";
import { installPlugin, type InstallSource } from "@/services/marketplace/install";
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

export function buildJobHandlers(db: SupabaseClient): JobHandlers {
  const sites = supabaseSitesRepo(db);
  const snapshots = supabaseSnapshotsRepo(db);
  const security = supabaseSecurityRepo(db);
  const jobs = supabaseJobsRepo(db);
  const seo = supabaseSeoRepo(db);

  return {
    snapshot_refresh: async ({ job }) => {
      if (!job.site_id) throw new Error("snapshot_refresh requires site_id");
      await refreshSnapshot({ sites, snapshots, mcp: createSiteMcpClient }, job.site_id);
    },
    security_scan: async ({ job }) => {
      if (!job.site_id) throw new Error("security_scan requires site_id");
      await securityScan({ sites, snapshots, security, mcp: createSiteMcpClient }, job.site_id);
    },
    vuln_feed_refresh: async () => {
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
      let source: InstallSource;
      if (p.source.kind === "upload") {
        const { data, error } = await db.storage.from("plugins").createSignedUrl(p.source.path, 3600);
        if (error || !data?.signedUrl) {
          throw new Error(`Could not sign uploaded plugin URL: ${error?.message ?? "unknown"}`);
        }
        source = { kind: "url", url: data.signedUrl };
      } else {
        source = p.source;
      }
      const result = await installPlugin(
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
        job.id, p.config_id, p.keyword,
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
      if (!result.ok) throw new Error(result.error ?? "Bulk action failed");
    },
  };
}
