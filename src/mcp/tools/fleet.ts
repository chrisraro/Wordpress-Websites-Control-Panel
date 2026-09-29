import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import {
  ok, fail, ENVIRONMENT_NOTE, CONFIRM_SHAPE, SKIP_BACKUP_SHAPE, gateConfirm, redactArgs, requirePermission,
} from "../confirm";
import { siteSummary } from "./sites";
import type { ToolCtx } from "../context";
import { friendlySiteError } from "@/lib/mcp/errors";
import { backupPayload } from "@/services/backup/choice";

const PERMISSION = "wp_toolkit.manage" as const;

/** Writes the audit row; logs and swallows a failure so it never changes the result. */
async function safeAudit(ctx: ToolCtx, detail: Record<string, unknown>): Promise<void> {
  try {
    await ctx.audit("mcp.update_all_plugins_fleet", null, detail);
  } catch (e) {
    console.error("[mcp] update_all_plugins_fleet audit write failed:", e);
  }
}

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "update_all_plugins_fleet",
    {
      description:
        "Queue \"update every plugin with an update available\" across every " +
        "site you can manage in one environment, in a single batch. Skips " +
        "disabled sites, sites with nothing to update, and any site that " +
        "already has an update run queued -- two concurrent update passes " +
        "on one WordPress install is how a plugin directory gets corrupted. " +
        "Each site is backed up with its own UpdraftPlus before its update " +
        "runs (the update waits up to 60 minutes for it); a site without " +
        "UpdraftPlus fails instead of updating. Pass skip_backup: true only " +
        `when the user explicitly wants to update without a backup. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        environment: z
          .enum(["production", "staging"])
          .describe("Which environment's sites to queue plugin updates for."),
        ...SKIP_BACKUP_SHAPE,
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { environment, skip_backup } = args;
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
          (skips.length > 0 ? ` Skipping ${skips.join(" and ")}.` : "") +
          (skip_backup
            ? " They will update WITHOUT a backup (skip_backup: true)."
            : " Each site is backed up with UpdraftPlus first; a site without it fails instead of updating.");

        const gate = gateConfirm(ctx.auth, "update_all_plugins_fleet", args, summary, {
          sites: plan.eligible.map(siteSummary),
          skipped_already_queued: plan.alreadyQueued.length,
          skipped_no_updates: plan.noUpdates.length,
          backup: skip_backup ? "skip" : "required",
        });
        if (!gate.proceed) return gate.result;

        const siteIds = plan.eligible.map((s) => s.id);
        // Settle the action first; the audit write is separate so a logging
        // failure after the batch is queued cannot report failure (and invite
        // a duplicate retry) or record a second, contradictory audit row.
        let batch: { batchId: string; count: number };
        try {
          batch = await ctx.enqueueBatch(
            ctx.jobs, "update_all_plugins", siteIds,
            { actor: ctx.auth.viewer.id, ...backupPayload(skip_backup ? "skip" : "required") },
          );
        } catch (e) {
          const message = friendlySiteError(e);
          await safeAudit(ctx, {
            reason: gate.reason, args: redactArgs(args), ok: false, error: message,
          });
          return fail(message);
        }
        await safeAudit(ctx, {
          reason: gate.reason, args: redactArgs(args), ok: true, site_ids: siteIds,
        });
        return ok({ batch_id: batch.batchId, count: batch.count, sites: plan.eligible.map(siteSummary) });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
