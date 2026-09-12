import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import { ok, fail, ENVIRONMENT_NOTE } from "../confirm";
import { siteSummary, NOT_FOUND } from "./sites";
import type { ToolCtx } from "../context";
import { getSite } from "@/services/sites/service";
import { friendlySiteError } from "@/lib/mcp/errors";
import { canAccessSite } from "@/lib/authz/decide";

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "get_security",
    {
      description:
        "Get a site's latest security posture: the overall grade and score, " +
        "currently open vulnerabilities with severity and fix versions, and the " +
        `latest set of security checks and their results. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async ({ site_id }) => {
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        const site = await getSite(ctx.sites, site_id);
        if (!site) return fail(NOT_FOUND);
        const [grade, openVulnerabilities, checks] = await Promise.all([
          ctx.security.latestGrade(site_id),
          ctx.security.openVulns(site_id),
          ctx.security.latestChecks(site_id),
        ]);
        return ok({
          site: siteSummary(site),
          grade: grade ?? null,
          open_vulnerabilities: openVulnerabilities,
          checks: checks ?? null,
          note: grade || checks
            ? undefined
            : "No security data has been collected yet. Use refresh_security to collect it.",
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
