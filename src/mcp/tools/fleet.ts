import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import {
  ok, fail, ENVIRONMENT_NOTE, CONFIRM_SHAPE, gateConfirm, redactArgs, requirePermission,
} from "../confirm";
import { siteSummary } from "./sites";
import type { ToolCtx } from "../context";
import { friendlySiteError } from "@/lib/mcp/errors";

const PERMISSION = "wp_toolkit.manage" as const;

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "update_all_plugins_fleet",
    {
      description:
        "Queue \"update every plugin with an update available\" across every " +
        "site you can manage in one environment, in a single batch. Skips " +
        "disabled sites, sites with nothing to update, and any site that " +
        "already has an update run queued -- two concurrent update passes " +
        `on one WordPress install is how a plugin directory gets corrupted. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        environment: z
          .enum(["production", "staging"])
          .describe("Which environment's sites to queue plugin updates for."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { environment } = args;
      const permDenied = requirePermission(ctx.auth, PERMISSION);
      if (permDenied) return permDenied;

      try {
        const plan = await ctx.planFleetPluginUpdate(
          { sites: ctx.sites, snapshots: ctx.inventory, jobs: ctx.jobs },
          ctx.auth.viewer,
          environment,
        );

        if (plan.eligible.length === 0) {
          return fail(
            plan.alreadyQueued.length > 0
              ? "Already queued -- those sites have plugin updates pending from an earlier run."
              : `No ${environment} site has a plugin update waiting.`,
          );
        }

        const names = plan.eligible.map((s) => `${s.name} (${environment})`).join(", ");
        const skips: string[] = [];
        if (plan.alreadyQueued.length > 0) {
          skips.push(`${plan.alreadyQueued.length} already queued from an earlier run`);
        }
        if (plan.noUpdates.length > 0) {
          skips.push(`${plan.noUpdates.length} with nothing to update`);
        }
        const summary =
          `Would queue plugin updates for ${plan.eligible.length} site(s): ${names}.` +
          (skips.length > 0 ? ` Skipping ${skips.join(" and ")}.` : "");

        const gate = gateConfirm(ctx.auth, args, summary, {
          sites: plan.eligible.map(siteSummary),
          skipped_already_queued: plan.alreadyQueued.length,
          skipped_no_updates: plan.noUpdates.length,
        });
        if (!gate.proceed) return gate.result;

        const siteIds = plan.eligible.map((s) => s.id);
        try {
          const { batchId, count } = await ctx.enqueueBatch(
            ctx.jobs, "update_all_plugins", siteIds, { actor: ctx.auth.viewer.id },
          );
          await ctx.audit("mcp.update_all_plugins_fleet", null, {
            reason: gate.reason, args: redactArgs(args), ok: true, site_ids: siteIds,
          });
          return ok({ batch_id: batchId, count, sites: plan.eligible.map(siteSummary) });
        } catch (e) {
          const message = friendlySiteError(e);
          await ctx.audit("mcp.update_all_plugins_fleet", null, {
            reason: gate.reason, args: redactArgs(args), ok: false, error: message,
          });
          return fail(message);
        }
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
