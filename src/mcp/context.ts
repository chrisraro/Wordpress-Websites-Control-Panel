import { createServiceSupabase } from "@/lib/supabase/server";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo, type JobsRepo } from "@/services/jobs/repo";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSecurityRepo, type OpenVuln } from "@/services/security/repo";
import { supabaseSeoRepo, type SeoSnapshotRow } from "@/services/seo/repo";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { supabaseReportsRepo, type ReportRow } from "@/services/reports/repo";
import type { SitesDeps } from "@/services/sites/service";
import { manageSite, type ManageDeps } from "@/services/manage/service";
import type { TokenAuth } from "@/lib/authz/token";
import type { InventoryPayload } from "@/services/inventory/types";
import type { Grade, SecurityCheck } from "@/services/security/types";
import type { SeoSource } from "@/services/seo/types";
import type { GeoGridConfig, GeoGridSnapshot } from "@/services/geogrid/types";
import type { JobRow, JobStatus } from "@/services/jobs/types";

/** The one read `get_inventory` needs -- not the writer used by the collector. */
export interface InventoryReadDeps {
  latestSnapshot(siteId: string): Promise<{ payload: InventoryPayload; taken_at: string } | null>;
}

/** The three reads `get_security` needs -- no feed or write access. */
export interface SecurityReadDeps {
  latestGrade(siteId: string): Promise<Grade | null>;
  openVulns(siteId: string): Promise<OpenVuln[]>;
  latestChecks(siteId: string): Promise<{ runAt: string; checks: SecurityCheck[] } | null>;
}

/** The one read `get_seo` needs -- not history, score trend, or the writer. */
export interface SeoReadDeps {
  latestBySource(siteId: string): Promise<Partial<Record<SeoSource, SeoSnapshotRow>>>;
}

/** The two reads `get_geogrid` needs -- not config upsert or snapshot history. */
export interface GeoGridReadDeps {
  getConfigBySite(siteId: string): Promise<GeoGridConfig | null>;
  latestPerKeyword(configId: string): Promise<Record<string, GeoGridSnapshot>>;
}

/** The two reads `list_reports` and `get_report_link` need -- not insert, revoke, or storage. */
export interface ReportsReadDeps {
  listForSite(siteId: string, limit?: number): Promise<ReportRow[]>;
  getById(id: string): Promise<ReportRow | null>;
}

/** The two reads `list_jobs` and `get_batch` need -- no claim, write, or dismiss access. */
export interface JobsReadDeps {
  listJobs(filter: { siteIds: string[] | null; status?: JobStatus; limit: number }): Promise<JobRow[]>;
  batchJobs(batchId: string): Promise<JobRow[]>;
}

export interface ToolCtx {
  auth: TokenAuth;
  sites: SitesDeps;
  manage: ManageDeps;
  jobs: JobsRepo;
  inventory: InventoryReadDeps;
  security: SecurityReadDeps;
  seo: SeoReadDeps;
  geogrid: GeoGridReadDeps;
  reports: ReportsReadDeps;
  jobsRead: JobsReadDeps;
  /**
   * One activity_log row. Writes and enqueues only -- reads are never audited,
   * because activity_log records changes and logging reads would bury them.
   */
  audit(action: string, siteId: string | null, detail: Record<string, unknown>): Promise<void>;
  /**
   * The seam a destructive single-site tool calls instead of importing
   * `manageSite` from "@/services/manage/service" directly. Injectable so a
   * dry-run test can assert that *no* service call happened -- there would
   * be nothing to intercept if the tool imported the real function itself.
   */
  manageSite: typeof manageSite;
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
    inventory: supabaseSnapshotsRepo(db),
    security: supabaseSecurityRepo(db),
    seo: supabaseSeoRepo(db),
    geogrid: supabaseGeoGridRepo(db),
    reports: supabaseReportsRepo(db),
    // Same repo instance as `jobs` above -- JobsRepo (writes and all) is a
    // superset of JobsReadDeps. A distinct field exists so the read tools
    // only ever declare the two methods they actually use.
    jobsRead: jobs,
    manageSite,
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
