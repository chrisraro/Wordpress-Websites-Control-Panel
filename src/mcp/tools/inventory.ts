import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import { ok, fail, ENVIRONMENT_NOTE, requirePermission, requireWritableToken, redactArgs } from "../confirm";
import { siteSummary, NOT_FOUND } from "./sites";
import type { ToolCtx } from "../context";
import { getSite } from "@/services/sites/service";
import { enqueueJob } from "@/services/jobs/service";
import { friendlySiteError, siteText } from "@/lib/mcp/errors";
import { canAccessSite } from "@/lib/authz/decide";
import type { InventoryPayload } from "@/services/inventory/types";

/** Plugin/theme titles are chosen by whoever wrote the plugin. */
const TITLE_MAX = 120;

type Snapshot = { payload: InventoryPayload; taken_at: string };

/**
 * Plugin and theme titles are free text from the plugin's own header -- any
 * author can put markup or instructions aimed at the model reading this
 * output there. Stripped and capped (audit 2026-09-29, open 5); identifiers
 * (file, slug, versions) are left as collected.
 */
function boundTitles(snapshot: Snapshot): Snapshot {
  const bound = <T extends { title?: string }>(item: T): T =>
    item.title === undefined ? item : { ...item, title: siteText(item.title, TITLE_MAX) };
  const payload = snapshot.payload;
  return {
    ...snapshot,
    payload: {
      ...payload,
      plugins: Array.isArray(payload.plugins) ? payload.plugins.map(bound) : payload.plugins,
      themes: Array.isArray(payload.themes) ? payload.themes.map(bound) : payload.themes,
    },
  };
}

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
          snapshot: snapshot ? boundTitles(snapshot) : null,
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
        if (job === null) {
          return ok({
            queued: false,
            job_id: null,
            note: "An inventory refresh is already pending for this site; nothing new was queued.",
          });
        }
        await ctx.audit("mcp.refresh_inventory", site_id, { args: redactArgs(args) });
        return ok({ queued: true, job_id: job.id, note: "Queued. Poll list_jobs for completion." });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
