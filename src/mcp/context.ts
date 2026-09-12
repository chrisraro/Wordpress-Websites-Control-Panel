import { createServiceSupabase } from "@/lib/supabase/server";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo, type JobsRepo } from "@/services/jobs/repo";
import type { SitesDeps } from "@/services/sites/service";
import type { ManageDeps } from "@/services/manage/service";
import type { TokenAuth } from "@/lib/authz/token";

export interface ToolCtx {
  auth: TokenAuth;
  sites: SitesDeps;
  manage: ManageDeps;
  jobs: JobsRepo;
  /**
   * One activity_log row. Writes and enqueues only -- reads are never audited,
   * because activity_log records changes and logging reads would bury them.
   */
  audit(action: string, siteId: string | null, detail: Record<string, unknown>): Promise<void>;
}

/**
 * Builds the real dependency set for one request, mirroring what the server
 * actions under src/app/(dashboard) construct, so a tool and the equivalent
 * button run identical code below the service boundary.
 *
 * There is deliberately no `db` on ToolCtx: a tool that queries directly would
 * bypass the authorization and audit behaviour every service function carries,
 * and tests/mcp-tools-structure.test.ts scans for exactly that.
 */
export function buildToolCtx(auth: TokenAuth): ToolCtx {
  const db = createServiceSupabase();
  const sitesRepo = supabaseSitesRepo(db);
  const jobs = supabaseJobsRepo(db);
  return {
    auth,
    jobs,
    sites: { repo: sitesRepo, mcp: createSiteMcpClient, jobs },
    manage: { sites: sitesRepo, jobs, mcp: createSiteMcpClient },
    async audit(action, siteId, detail) {
      await sitesRepo.insertActivity({
        actor: auth.viewer.id,
        // insertActivity's site_id is optional (string | undefined), not
        // nullable -- audit's own signature stays `siteId: string | null` for
        // fleet-wide actions that have no site, and converts at this boundary.
        site_id: siteId ?? undefined,
        action,
        // detail last-writes over token_id, not the other way around: a
        // caller-supplied detail carrying its own `token_id` key (e.g. a
        // destructive tool auditing redactArgs(args), which rewrites any
        // `/token/i` key to "[redacted]") must never overwrite the
        // authoritative value -- that would sever the only link back to
        // which API token performed the action.
        detail: { ...detail, token_id: auth.tokenId },
      });
    },
  };
}
