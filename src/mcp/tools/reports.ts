import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import { ok, fail, ENVIRONMENT_NOTE, requirePermission, requireWritableToken, redactArgs } from "../confirm";
import { siteSummary, NOT_FOUND } from "./sites";
import type { ToolCtx } from "../context";
import { getSite, listSitesForViewer } from "@/services/sites/service";
import type { SiteRow } from "@/services/sites/types";
import { enqueueJob } from "@/services/jobs/service";
import { parseSections } from "@/services/reports/types";
import { friendlySiteError } from "@/lib/mcp/errors";
import { canAccessSite } from "@/lib/authz/decide";

/**
 * A report the caller cannot reach: either no such id, or its site is not
 * visible to them. Not distinguished from each other, for the same reason
 * `NOT_FOUND` in ./sites is not: the existence of a client's report is
 * itself information.
 */
const REPORT_NOT_FOUND = "Report not found.";

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "list_reports",
    {
      description:
        "List generated PDF reports, most recent first: when each was " +
        "generated, its date range and sections, and whether it was created " +
        "automatically. Does not include the share link itself -- call " +
        `get_report_link for that. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z
          .string()
          .uuid()
          .optional()
          .describe("Limit to one site's reports. Omit to list across every site you can see."),
      },
    },
    async ({ site_id }) => {
      if (site_id && !canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        let sites: SiteRow[];
        if (site_id) {
          const site = await getSite(ctx.sites, site_id);
          if (!site) return fail(NOT_FOUND);
          sites = [site];
        } else {
          sites = await listSitesForViewer(ctx.sites, ctx.auth.viewer);
        }
        const siteById = new Map(sites.map((s) => [s.id, s]));
        const lists = await Promise.all(sites.map((s) => ctx.reports.listForSite(s.id)));
        const reports = lists
          .flat()
          .sort((a, b) => b.generated_at.localeCompare(a.generated_at))
          // Explicit field list, not `...rest`: a report row also carries
          // `share_token` (excluded on purpose -- see get_report_link) and
          // `storage_path`, an internal bucket path with no use to an MCP
          // caller. Naming fields here means a future column added to the
          // row does not leak by default.
          .map((r) => ({
            id: r.id,
            site: siteById.has(r.site_id) ? siteSummary(siteById.get(r.site_id)!) : null,
            generated_at: r.generated_at,
            sections: r.sections,
            period_start: r.period_start,
            period_end: r.period_end,
            auto: r.auto,
          }));
        return ok({ count: reports.length, reports });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "get_report_link",
    {
      description:
        "Get the shareable link for one generated report, by the id from " +
        "list_reports. A report's share link is the only thing that " +
        "controls who can open it, so list_reports never includes it -- this " +
        "is the deliberate second step. If the link was revoked, this says " +
        `so instead of returning a broken URL. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        report_id: z.string().uuid().describe("The report's id, from list_reports."),
      },
    },
    async ({ report_id }) => {
      try {
        const report = await ctx.reports.getById(report_id);
        if (!report) return fail(REPORT_NOT_FOUND);
        if (!canAccessSite(ctx.auth.viewer, report.site_id, "read")) return fail(REPORT_NOT_FOUND);
        const site = await getSite(ctx.sites, report.site_id);
        if (!report.share_token) {
          return ok({
            report_id: report.id,
            site: site ? siteSummary(site) : null,
            revoked: true,
            path: null,
            note: "This report's share link has been revoked. Generate a new report to get a fresh link.",
          });
        }
        return ok({
          report_id: report.id,
          site: site ? siteSummary(site) : null,
          revoked: false,
          path: `/r/${report.share_token}`,
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "generate_report",
    {
      description:
        "Queue a PDF report for a site covering the given sections over the " +
        "given period. Returns a job id; the work runs on the queue within " +
        "about a minute, not during this call. Poll list_jobs for " +
        `completion, then get_report_link for its share link. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        sections: z
          .array(z.enum(["security", "seo", "geogrid", "inventory"]))
          .min(1)
          .default(["security", "seo", "geogrid", "inventory"])
          .describe("Which sections to include in the report."),
        period_days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(30)
          .describe("Number of days the report covers, 1-365."),
      },
    },
    async (args) => {
      const { site_id, sections: rawSections, period_days } = args;
      const permDenied = requirePermission(ctx.auth, "reports.generate");
      if (permDenied) return permDenied;
      const tokenDenied = requireWritableToken(ctx.auth);
      if (tokenDenied) return tokenDenied;
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);

      const sections = parseSections(rawSections);
      if (sections.length === 0) return fail("Choose at least one section.");

      try {
        const site = await getSite(ctx.sites, site_id);
        if (!site) return fail(NOT_FOUND);
        const job = await enqueueJob(
          ctx.jobs, "report_generate", site_id,
          { sections, period_days }, { dedupe: true },
        );
        await ctx.audit("mcp.generate_report", site_id, { args: redactArgs(args) });
        return ok({
          queued: job !== null,
          job_id: job?.id ?? null,
          note: job === null
            ? "A report is already pending for this site; nothing new was queued."
            : "Queued. Poll list_jobs for completion.",
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
