import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import { ok, fail, ENVIRONMENT_NOTE, requirePermission, requireWritableToken, redactArgs } from "../confirm";
import { siteSummary, NOT_FOUND } from "./sites";
import type { ToolCtx } from "../context";
import { getSite } from "@/services/sites/service";
import { enqueueGeoGridRun } from "@/services/geogrid/enqueue";
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

  server.registerTool(
    "run_geogrid",
    {
      description:
        "Queue a GeoGrid local-rank run for a site: one job per tracked " +
        "keyword, all sharing one batch id. Requires a saved GeoGrid " +
        "configuration with at least one keyword -- use get_geogrid to " +
        "check first. Returns the batch id; the work runs on the queue " +
        `within about a minute. Poll get_batch for completion. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async (args) => {
      const { site_id } = args;
      const permDenied = requirePermission(ctx.auth, "geogrid.manage");
      if (permDenied) return permDenied;
      const tokenDenied = requireWritableToken(ctx.auth);
      if (tokenDenied) return tokenDenied;
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);

      try {
        const site = await getSite(ctx.sites, site_id);
        if (!site) return fail(NOT_FOUND);
        const config = await ctx.geogrid.getConfigBySite(site_id);
        if (!config) {
          return fail("This site has no GeoGrid configuration yet. Set one up before running GeoGrid.");
        }
        if (config.keywords.length === 0) {
          return fail("This site's GeoGrid configuration has no keywords. Add at least one before running GeoGrid.");
        }

        const { batchId, queued } = await enqueueGeoGridRun(ctx.jobs, site_id, config);
        await ctx.audit("mcp.run_geogrid", site_id, {
          args: redactArgs(args),
          keywords: config.keywords.length,
        });
        return ok({
          site: siteSummary(site),
          batch_id: batchId,
          queued,
          note: "Queued. Poll get_batch for completion.",
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
