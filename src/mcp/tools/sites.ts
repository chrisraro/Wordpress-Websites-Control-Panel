import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import {
  ok, fail, ENVIRONMENT_NOTE, requirePermission, requireWritableToken, redactArgs,
} from "../confirm";
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

  // Mirrors the panel's "Test connection" button -- `runConnectionTest` in
  // src/app/(dashboard)/sites/[id]/actions.ts -- which requires
  // `sites.manage`. A token must never be able to do over MCP what the same
  // user cannot do in the panel (final review, Fix 3). The permission check
  // runs first: on a read-only token `applyReadOnly` has stripped
  // sites.manage, and `requirePermission` then returns the read-only-token
  // refusal itself, so a read-only caller is still told to mint a writable
  // token rather than to ask for a permission they hold.
  server.registerTool(
    "test_site_connection",
    {
      description:
        "Open a connection to a site over MCP to check that it's reachable. " +
        "This changes nothing on the WordPress site itself, but it records the " +
        "resulting status and an activity-log entry in the panel, so it needs " +
        `the sites.manage permission and a token minted read-only cannot call it. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async (args) => {
      const { site_id } = args;
      const permDenied = requirePermission(ctx.auth, "sites.manage");
      if (permDenied) return permDenied;
      const tokenDenied = requireWritableToken(ctx.auth);
      if (tokenDenied) return tokenDenied;
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        const result = await testSiteConnection(ctx.sites, site_id, ctx.auth.viewer.id);
        // The service writes its own `site.test_connection` row, which a
        // panel click writes too. This row is what makes a token-driven
        // probe distinguishable from a click: it carries the `mcp.` action
        // and, through ctx.audit, the token id.
        await ctx.audit("mcp.test_site_connection", site_id, { args: redactArgs(args), ok: result.ok });
        return ok(result);
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
