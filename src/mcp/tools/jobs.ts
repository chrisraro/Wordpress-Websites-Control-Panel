import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import {
  ok, fail, ENVIRONMENT_NOTE, CONFIRM_SHAPE, gateConfirm, redactArgs, requirePermission,
} from "../confirm";
import { siteSummary, NOT_FOUND } from "./sites";
import type { ToolCtx } from "../context";
import { listSites } from "@/services/sites/service";
import { friendlySiteError } from "@/lib/mcp/errors";
import { canAccessSite, visibleSiteIds } from "@/lib/authz/decide";

/**
 * A batch the caller cannot reach at all: either no such id, or every job in
 * it belongs to a site they cannot see. Same "not found, not forbidden"
 * reasoning as ./sites#NOT_FOUND, and also covers a genuinely empty batch --
 * see get_batch below for why that case is folded in here rather than
 * reported separately.
 */
const BATCH_NOT_FOUND = "Batch not found.";

const JOB_STATUS = ["pending", "running", "awaiting_callback", "done", "failed"] as const;

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "list_jobs",
    {
      description:
        "List queued and recent background jobs -- inventory refreshes, " +
        "security scans, SEO scans, GeoGrid runs, report generation, plugin " +
        "installs and the like -- most recently scheduled first. Each job " +
        `names its site, if it has one. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z
          .string()
          .uuid()
          .optional()
          .describe("Limit to one site's jobs. Omit to list across every site you can see."),
        status: z
          .enum(JOB_STATUS)
          .optional()
          .describe("Limit to jobs in this status."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum number of jobs to return, 1-100."),
      },
    },
    async ({ site_id, status, limit }) => {
      if (site_id && !canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        const sites = await listSites(ctx.sites);
        const siteById = new Map(sites.map((s) => [s.id, s]));

        let siteIds: string[] | null;
        if (site_id) {
          siteIds = [site_id];
        } else {
          const visible = visibleSiteIds(ctx.auth.viewer, sites.map((s) => s.id));
          siteIds = visible === "all" ? null : visible;
        }

        // A viewer with no grants and no sites.view_all has an empty visible
        // set. Passing that through would reach PostgREST as
        // `site_id=in.()`, which no other query in this codebase does --
        // short-circuit instead of relying on how that's handled downstream.
        if (Array.isArray(siteIds) && siteIds.length === 0) {
          return ok({ count: 0, jobs: [] });
        }

        const jobs = await ctx.jobsRead.listJobs({ siteIds, status, limit });
        return ok({
          count: jobs.length,
          jobs: jobs.map((j) => ({
            id: j.id,
            type: j.type,
            site: j.site_id && siteById.has(j.site_id) ? siteSummary(siteById.get(j.site_id)!) : null,
            status: j.status,
            attempts: j.attempts,
            scheduled_for: j.scheduled_for,
            last_error: j.last_error,
            cancelled_at: j.cancelled_at ?? null,
            batch_id: j.batch_id,
          })),
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "get_batch",
    {
      description:
        "Get the status of a batch of jobs -- a bulk action across one " +
        "site's items, or one item installed across many sites: every job " +
        "in it with its site, status and any error, and whether the whole " +
        "batch has finished. Jobs on sites you cannot see are left out, and " +
        `a batch with nothing left visible is reported as not found. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        batch_id: z.string().uuid().describe("The batch's id, from a bulk action or install result."),
      },
    },
    async ({ batch_id }) => {
      try {
        const [jobs, sites] = await Promise.all([
          ctx.jobsRead.batchJobs(batch_id),
          listSites(ctx.sites),
        ]);

        // A batch's jobs may span sites the caller cannot see. Filter to
        // visible sites before anything about the batch -- including site
        // names -- reaches the result. If nothing remains, report not found
        // rather than an empty list: an empty `jobs: []` with `done: true`
        // would still confirm the batch id exists to someone who should not
        // know that. This also 404s a genuinely empty batch, matching
        // src/app/api/batches/[id]/route.ts, which this tool mirrors.
        const visible = visibleSiteIds(ctx.auth.viewer, sites.map((s) => s.id));
        const visibleJobs = visible === "all"
          ? jobs
          : jobs.filter((j) => j.site_id && visible.includes(j.site_id));
        if (visibleJobs.length === 0) return fail(BATCH_NOT_FOUND);

        const siteById = new Map(sites.map((s) => [s.id, s]));
        const rows = visibleJobs.map((j) => {
          const site = j.site_id && siteById.has(j.site_id) ? siteSummary(siteById.get(j.site_id)!) : null;
          // `type` ("plugin_install" vs "bulk_manage") plus this non-secret
          // bulk metadata is what lets a caller tell what the batch is
          // actually doing instead of just that jobs exist -- mirrors
          // src/app/api/batches/[id]/route.ts.
          const payload = j.payload as { label?: unknown; kind?: unknown; target?: unknown; activate?: unknown };
          const payloadLabel = payload.label;
          return {
            id: j.id,
            type: j.type,
            site,
            status: j.status,
            attempts: j.attempts,
            last_error: j.last_error,
            cancelled_at: j.cancelled_at ?? null,
            // Bulk batches are one site, many items; install batches are one
            // item, many sites. The payload label distinguishes them.
            label: typeof payloadLabel === "string" && payloadLabel ? payloadLabel : site?.name ?? "—",
            kind: typeof payload.kind === "string" ? payload.kind : undefined,
            target: typeof payload.target === "string" ? payload.target : undefined,
            activate: typeof payload.activate === "boolean" ? payload.activate : undefined,
          };
        });
        // A cancelled job will never be claimed, so a batch whose remaining
        // work is all cancelled is finished too.
        const done = rows.every((r) => r.status === "done" || r.status === "failed" || r.cancelled_at !== null);
        return ok({ batch_id, jobs: rows, done });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "cancel_batch",
    {
      description:
        "Cancel the still-queued jobs in a batch. Only pending jobs are " +
        "stopped: a job already running is executing PHP on a live " +
        "WordPress install and cannot be reached from here, and a job " +
        "awaiting an external callback is equally out of reach. The count " +
        "returned is what was actually stopped, which can be fewer than the " +
        "batch's total size -- this never claims to have undone work that " +
        `had already started. Not scoped to a site. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        batch_id: z.string().uuid().describe("The batch's id, from get_batch or list_jobs."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { batch_id } = args;
      const permDenied = requirePermission(ctx.auth, "queue.process");
      if (permDenied) return permDenied;

      try {
        const [jobs, sites] = await Promise.all([
          ctx.jobsRead.batchJobs(batch_id),
          listSites(ctx.sites),
        ]);

        // Same "not found, not forbidden" rule get_batch applies: filter to
        // visible sites before anything about the batch -- including
        // whether it exists at all -- reaches a preview. An empty preview
        // that still resolved to "0 pending" would confirm the batch id
        // exists to someone who should not know that.
        const visible = visibleSiteIds(ctx.auth.viewer, sites.map((s) => s.id));
        const visibleJobs = visible === "all"
          ? jobs
          : jobs.filter((j) => j.site_id && visible.includes(j.site_id));
        if (visibleJobs.length === 0) return fail(BATCH_NOT_FOUND);

        const pending = visibleJobs.filter((j) => j.status === "pending" && !j.cancelled_at);
        const notPending = visibleJobs.length - pending.length;

        // Nothing visible is pending: there is nothing to gate a confirm on
        // and nothing that would be attempted, so this returns before
        // gateConfirm and leaves no audit row -- the same "no-op enqueues
        // are not audited" rule commit af7809e established for the enqueue
        // tools' `dedupe: true` no-op path.
        if (pending.length === 0) {
          return ok({
            batch_id,
            cancelled: 0,
            note: `None of this batch's ${visibleJobs.length} visible job(s) are still pending.`,
          });
        }

        const summary = `Would stop ${pending.length} still-pending job(s) in this batch.` +
          (notPending > 0
            ? ` ${notPending} job(s) are already running, finished, or cancelled, and cannot be reached from here.`
            : "");

        const gate = gateConfirm(ctx.auth, args, summary, {
          batch_id, pending: pending.length, not_pending: notPending,
        });
        if (!gate.proceed) return gate.result;

        try {
          // Cancel exactly the visible pending ids the preview named --
          // never the whole batch_id (cancelBatch), which would also reach
          // jobs on sites this caller cannot see. See JobsRepo#cancelJobs.
          const cancelled = await ctx.jobs.cancelJobs(pending.map((j) => j.id));
          await ctx.audit("mcp.cancel_batch", null, {
            reason: gate.reason, args: redactArgs(args), ok: true, cancelled,
          });
          return ok({
            batch_id,
            cancelled,
            note: cancelled < pending.length
              ? `${cancelled} of the batch's visible pending jobs were stopped; ` +
                "the rest started running, or finished, or were cancelled elsewhere before this could reach them."
              : undefined,
          });
        } catch (e) {
          const message = friendlySiteError(e);
          await ctx.audit("mcp.cancel_batch", null, {
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
