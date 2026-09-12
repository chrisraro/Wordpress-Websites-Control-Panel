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
    "get_seo",
    {
      description:
        "Get a site's latest SEO and AEO data, one entry per source: RankMath " +
        "audit score, per-page RankMath scores, internal/external link stats, " +
        "Google Search Console keywords, AI-visibility brand mentions, and " +
        `PageSpeed Insights. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async ({ site_id }) => {
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        const site = await getSite(ctx.sites, site_id);
        if (!site) return fail(NOT_FOUND);
        const sources = await ctx.seo.latestBySource(site_id);
        return ok({
          site: siteSummary(site),
          sources,
          note: Object.keys(sources).length > 0
            ? undefined
            : "No SEO data has been collected yet. Use refresh_seo to collect it.",
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
