import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import { ok, fail, ENVIRONMENT_NOTE } from "../confirm";
import { siteSummary, NOT_FOUND } from "./sites";
import type { ToolCtx } from "../context";
import { getSite, listSitesForViewer } from "@/services/sites/service";
import type { SiteRow } from "@/services/sites/types";
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
          .map(({ share_token: _share_token, ...rest }) => ({
            ...rest,
            site: siteById.has(rest.site_id) ? siteSummary(siteById.get(rest.site_id)!) : null,
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
}
