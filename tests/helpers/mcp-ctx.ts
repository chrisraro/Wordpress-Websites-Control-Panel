import type { ToolCtx } from "@/mcp/context";
import type { TokenAuth } from "@/lib/authz/token";
import type { Viewer } from "@/lib/authz/decide";
import { APP_PERMISSIONS, type AppPermission } from "@/lib/authz/types";

/**
 * Not a `.test.ts` file on purpose: vitest's `include` glob in
 * vitest.config.ts only collects `tests/**\/*.test.ts`, so this module's
 * `describe`/`it` calls (there are none) never register, and importing it
 * from another test file never re-executes anything. It used to live as an
 * exported function inside tests/mcp-tools-reads.test.ts; tests/mcp-audit.test.ts
 * imported it from there, which made vitest treat that import as pulling in
 * a second test file's worth of `describe`/`it` registrations, running all
 * 35 of mcp-tools-reads.test.ts's tests a second time on every full-suite
 * run. Moving the shared fixture here removes that double-run.
 */

export const SITE_ID = "1b6e3d4f-5c7e-4a92-8d3b-6f4c2a9e7b51";
export const SITE = {
  id: SITE_ID, name: "Alpha", url: "https://alpha.test",
  environment: "production", status: "connected", client_label: null,
};

/** Shared batch id fixture -- used as the default ctx.jobsRead.batchJobs
 * payload below, and by tests/mcp-tools-reads.test.ts and
 * tests/mcp-tools-destructive.test.ts for `get_batch`/`cancel_batch`. */
export const BATCH_ID = "3d8a5f6b-7e9a-4c14-8f5d-8b6e4c2a9d73";

/**
 * Builds a ctx with fakes for every repo the read, enqueue and destructive
 * tool groups touch, recording audit calls, enqueued job inserts and raw
 * service-seam invocations so "nothing happened" assertions are real.
 *
 * Shared by tests/mcp-tools-reads.test.ts, tests/mcp-audit.test.ts and
 * tests/mcp-tools-destructive.test.ts.
 *
 * `manageSite` is the injectable seam `src/mcp/tools/manage.ts` calls
 * instead of importing `manageSite` from `@/services/manage/service`
 * directly -- see src/mcp/context.ts. The default stub here records the
 * call and succeeds, which is what lets a dry-run test assert that *no*
 * service call happened: if the tool called the real service, there would
 * be no seam to intercept it.
 */
export function ctxFor(opts: {
  permissions?: AppPermission[];
  grants?: [string, "read" | "manage"][];
  readOnly?: boolean;
  /** When true, `jobs.pendingExists` resolves `true` instead of the default
   * `false`, so tests can exercise `enqueueJob(..., { dedupe: true })`'s
   * no-op path (it returns `null` without inserting). */
  pendingExists?: boolean;
} = {}) {
  const audited: { action: string; siteId: string | null; detail: Record<string, unknown> }[] = [];
  const enqueued: { type: string; siteId: string | null; batchId: string | null; payload: Record<string, unknown> }[] = [];
  const serviceCalls: string[] = [];
  const viewer: Viewer = {
    id: "u1", email: null, role: "admin",
    // Defaults to every permission and a manage grant on the fixture site:
    // the destructive tools' tests call `ctxFor()` bare and expect the
    // happy path to work, opting into restriction only when a test is
    // specifically about a missing permission or grant. The read and
    // enqueue tests (mcp-tools-reads.test.ts, mcp-audit.test.ts) always pass
    // `permissions`/`grants` explicitly, so this default never affects them.
    permissions: new Set(opts.permissions ?? [...APP_PERMISSIONS]),
    grants: new Map(opts.grants ?? [[SITE_ID, "manage"]]),
  };
  const auth: TokenAuth = { viewer, tokenId: "tok-1", readOnly: Boolean(opts.readOnly) };
  return {
    auth,
    audited,
    enqueued,
    serviceCalls,
    sites: {
      repo: {
        listSites: async () => [SITE],
        getSite: async (id: string) => (id === SITE_ID ? SITE : null),
      },
    },
    // Shape mirrors ManageDeps (src/services/manage/service.ts). Never
    // exercised for real in these tests -- the `manageSite` seam below
    // intercepts every call -- but ctx.manage must exist because the tool
    // modules pass it through as the seam's first argument.
    manage: {
      sites: {
        getSite: async (id: string) => (id === SITE_ID ? SITE : null),
        getSiteCredentials: async () => ({ url: SITE.url }),
        insertActivity: async () => {},
      },
      jobs: {},
      mcp: () => { throw new Error("no network in tests"); },
    },
    inventory: {
      latestSnapshot: async () => ({
        payload: { core: { version: "6.8" }, plugins: [], themes: [] },
        taken_at: "2026-09-01T00:00:00Z",
      }),
    },
    security: {
      latestGrade: async () => ({ grade: "A" as const, score: 96 }),
      openVulns: async () => [],
      latestChecks: async () => ({ runAt: "2026-09-01T00:00:00Z", checks: [] }),
    },
    seo: { latestBySource: async () => ({}) },
    geogrid: {
      getConfigBySite: async () => null,
      latestPerKeyword: async () => ({}),
    },
    reports: {
      listForSite: async () => [],
      getById: async () => null,
    },
    jobsRead: {
      listJobs: async () => [],
      // A single pending job on the fixture site by default, so
      // `cancel_batch`'s existence/visibility check (mirroring get_batch's)
      // has something to find and its happy-path tests reach the confirm
      // gate instead of a not-found refusal. Tests that need a genuinely
      // empty or fully-invisible batch override this explicitly.
      batchJobs: async () => [{
        id: "job-1", type: "update_all_plugins" as const, site_id: SITE_ID,
        batch_id: BATCH_ID, payload: {}, status: "pending" as const, attempts: 0,
        scheduled_for: "2026-09-01T00:00:00Z", last_error: null,
        cancelled_at: null, dismissed_at: null, finished_at: null,
      }],
    },
    jobs: {
      insert: async (r: {
        type: string; site_id?: string | null; batch_id?: string | null;
        payload?: Record<string, unknown>;
      }) => {
        enqueued.push({
          type: r.type, siteId: r.site_id ?? null,
          batchId: r.batch_id ?? null, payload: r.payload ?? {},
        });
        return { id: "job-1" };
      },
      pendingExists: async () => Boolean(opts.pendingExists),
      // The write half of the seam `cancel_batch` calls -- see
      // src/services/jobs/repo.ts's JobsRepo#cancelBatch. Recorded like
      // `manageSite` below so a dry-run test can assert no service call
      // happened.
      async cancelBatch() {
        serviceCalls.push("cancelBatch");
        return 1;
      },
    },
    // The injectable seam -- see src/mcp/context.ts's `manageSite` field.
    async manageSite() {
      serviceCalls.push("manageSite");
      return { ok: true, output: "Done" };
    },
    /**
     * `update_all_plugins_fleet`'s two Task 10b seams.
     *
     * `planFleetPluginUpdate` is deliberately grant-aware rather than a dumb
     * recorder: it is also the tool's *preview* computation (called on every
     * dry run, not only on confirm), so it must behave like `loadSite` does
     * for the single-site tools -- respecting the fixture viewer's grants --
     * for the shared "ungranted caller" guard-order test to mean anything
     * for this tool. It is never pushed to `serviceCalls`: like `getSite`,
     * it is a read, not the action being gated.
     */
    async planFleetPluginUpdate(_deps: unknown, viewer: Viewer) {
      const canManage = viewer.permissions.has("sites.view_all") || viewer.grants.get(SITE_ID) === "manage";
      return {
        eligible: canManage ? [SITE] : [],
        alreadyQueued: [],
        noUpdates: [],
      };
    },
    async enqueueBatch() {
      serviceCalls.push("enqueueBatch");
      return { batchId: "b1", count: 1 };
    },
    // `install_gsc_verification` / `remove_gsc_verification`'s seam. `deps`
    // is never touched by these default stubs -- only a test that swaps in
    // the real `installVerificationFile`/`removeVerificationFile` functions
    // (to exercise their own validation) ever reaches into it.
    gsc: {
      async install() {
        serviceCalls.push("gscInstall");
        return {
          fileName: "google1234abcd5678.html",
          url: `${SITE.url}/google1234abcd5678.html`,
          sha256: "0".repeat(64),
          replaced: false,
          reachable: true,
        };
      },
      async remove() {
        serviceCalls.push("gscRemove");
      },
      deps: {
        repo: {
          getSite: async (id: string) => (id === SITE_ID ? SITE : null),
          getSiteCredentials: async () => ({ url: SITE.url }),
        },
        mcp: () => { throw new Error("no network in tests"); },
      },
    },
    async audit(action: string, siteId: string | null, detail: Record<string, unknown>) {
      audited.push({ action, siteId, detail });
    },
  } as unknown as ToolCtx & {
    audited: { action: string; siteId: string | null; detail: Record<string, unknown> }[];
    enqueued: { type: string; siteId: string | null; batchId: string | null; payload: Record<string, unknown> }[];
    serviceCalls: string[];
  };
}
