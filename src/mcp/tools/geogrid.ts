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
    "get_geogrid",
    {
      description:
        "Get a site's GeoGrid local-rank tracking: its configuration (business " +
        "name, keywords, grid size and center point) and, for each tracked " +
        `keyword, the most recent set of per-point rankings. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async ({ site_id }) => {
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        const site = await getSite(ctx.sites, site_id);
        if (!site) return fail(NOT_FOUND);
        const config = await ctx.geogrid.getConfigBySite(site_id);
        if (!config) {
          return ok({
            site: siteSummary(site),
            configured: false,
            config: null,
            keywords: {},
            note: "This site has no GeoGrid configuration yet. Set one up before running GeoGrid.",
          });
        }
        const keywords = await ctx.geogrid.latestPerKeyword(config.id);
        return ok({
          site: siteSummary(site),
          configured: true,
          config,
          keywords,
          note: Object.keys(keywords).length > 0
            ? undefined
            : "This site's GeoGrid is configured but has not produced any results yet. " +
              "run_geogrid collects them.",
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
