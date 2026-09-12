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
      batchJobs: async () => [],
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
    },
    // The injectable seam -- see src/mcp/context.ts's `manageSite` field.
    async manageSite() {
      serviceCalls.push("manageSite");
      return { ok: true, output: "Done" };
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
