import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import { ok, fail, ENVIRONMENT_NOTE, requirePermission, requireWritableToken, redactArgs } from "../confirm";
import { siteSummary, NOT_FOUND } from "./sites";
import type { ToolCtx } from "../context";
import { getSite } from "@/services/sites/service";
import { enqueueJob } from "@/services/jobs/service";
import { friendlySiteError } from "@/lib/mcp/errors";
import { canAccessSite } from "@/lib/authz/decide";

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "get_inventory",
    {
      description:
        "Get a site's latest inventory snapshot: WordPress core version, plugins " +
        "and themes with their versions and whether an update is available, " +
        `maintenance mode, and Google Search Console verification state. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async ({ site_id }) => {
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        const site = await getSite(ctx.sites, site_id);
        if (!site) return fail(NOT_FOUND);
        const snapshot = await ctx.inventory.latestSnapshot(site_id);
        return ok({
          site: siteSummary(site),
          snapshot: snapshot ?? null,
          note: snapshot
            ? undefined
            : "No inventory has been collected yet. Use refresh_inventory to collect it.",
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "refresh_inventory",
    {
      description:
        "Queue a fresh inventory collection for a site. Returns a job id; the work " +
        "runs on the queue within about a minute, not during this call. Poll " +
        `list_jobs for completion. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async (args) => {
      const { site_id } = args;
      const permDenied = requirePermission(ctx.auth, "sites.manage");
      if (permDenied) return permDenied;
      const tokenDenied = requireWritableToken(ctx.auth);
      if (tokenDenied) return tokenDenied;
      if (!canAccessSite(ctx.auth.viewer, site_id, "manage")) return fail(NOT_FOUND);

      try {
        const job = await enqueueJob(ctx.jobs, "snapshot_refresh", site_id, {}, { dedupe: true });
        await ctx.audit("mcp.refresh_inventory", site_id, { args: redactArgs(args) });
        return ok({
          queued: job !== null,
          job_id: job?.id ?? null,
          note: job === null
            ? "An inventory refresh is already pending for this site; nothing new was queued."
            : "Queued. Poll list_jobs for completion.",
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
