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
            : "No SEO data has been collected yet. Use run_seo_scan to collect it.",
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "run_seo_scan",
    {
      description:
        "Queue a fresh SEO/AEO scan for a site. Returns a job id; the work " +
        "runs on the queue within about a minute, not during this call. Poll " +
        `list_jobs for completion. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async (args) => {
      const { site_id } = args;
      const permDenied = requirePermission(ctx.auth, "seo.run");
      if (permDenied) return permDenied;
      const tokenDenied = requireWritableToken(ctx.auth);
      if (tokenDenied) return tokenDenied;
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);

      try {
        const job = await enqueueJob(ctx.jobs, "seo_scan", site_id, {}, { dedupe: true });
        if (job === null) {
          return ok({
            queued: false,
            job_id: null,
            note: "An SEO scan is already pending for this site; nothing new was queued.",
          });
        }
        await ctx.audit("mcp.run_seo_scan", site_id, { args: redactArgs(args) });
        return ok({ queued: true, job_id: job.id, note: "Queued. Poll list_jobs for completion." });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
