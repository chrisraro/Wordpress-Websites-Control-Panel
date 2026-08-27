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

interface PluginInstallPayload {
  source: InstallSource | { kind: "upload"; path: string };
  activate: boolean;
  actor: string;
}

export function buildJobHandlers(db: SupabaseClient): JobHandlers {
  const sites = supabaseSitesRepo(db);
  const snapshots = supabaseSnapshotsRepo(db);
  const security = supabaseSecurityRepo(db);
  const jobs = supabaseJobsRepo(db);

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
  };
}
