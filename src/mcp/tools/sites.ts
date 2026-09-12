import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import { ok, fail, ENVIRONMENT_NOTE } from "../confirm";
import type { ToolCtx } from "../context";
import { listSitesForViewer, getSite, testSiteConnection } from "@/services/sites/service";
import { siteEnvironment } from "@/services/sites/portfolio";
import { friendlySiteError } from "@/lib/mcp/errors";
import { canAccessSite } from "@/lib/authz/decide";
import type { SiteRow } from "@/services/sites/types";

/**
 * The site shape every tool returns. `environment` is never omitted.
 *
 * `SiteRow.environment` is optional -- code compiled against a database that
 * predates 0017_site_environment.sql still type-checks against it -- so this
 * resolves through `siteEnvironment()` rather than reading the field
 * directly, which would silently return `undefined` for such a row and
 * violate the one guarantee every site-bearing result must carry.
 */
export function siteSummary(site: SiteRow) {
  return {
    id: site.id,
    name: site.name,
    url: site.url,
    environment: siteEnvironment(site),
    status: site.status,
    client_label: site.client_label ?? null,
  };
}

/**
 * A site the viewer cannot reach is reported as not found, never as forbidden:
 * the existence of a client's site is itself information.
 */
export const NOT_FOUND = "Site not found.";

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "list_sites",
    {
      description:
        `List every WordPress site you can see, with its environment and status. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        environment: z
          .enum(["production", "staging"])
          .optional()
          .describe("Return only sites in this environment."),
      },
    },
    async ({ environment }) => {
      try {
        const all = await listSitesForViewer(ctx.sites, ctx.auth.viewer);
        const filtered = environment
          ? all.filter((s) => siteEnvironment(s) === environment)
          : all;
        return ok({ count: filtered.length, sites: filtered.map(siteSummary) });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "get_site",
    {
      description: `Get one site's details. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async ({ site_id }) => {
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        const site = await getSite(ctx.sites, site_id);
        if (!site) return fail(NOT_FOUND);
        return ok({ site: siteSummary(site) });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "test_site_connection",
    {
      description:
        "Check that the panel can still reach a site over MCP and report its status. " +
        `This is a read: it changes nothing on the site. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async ({ site_id }) => {
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        return ok(await testSiteConnection(ctx.sites, site_id, ctx.auth.viewer.id));
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
