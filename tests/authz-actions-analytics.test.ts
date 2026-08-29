import { beforeEach, describe, expect, it, vi } from "vitest";

// These server actions are the phase-9a enforcement points for security/SEO
// scans, GeoGrid, reports, and the job queue. Before this task every exported
// action here succeeded for any authenticated user regardless of role or
// site grant — including `processQueueNowAction`, an exported helper that is
// a publicly invokable endpoint in its own right (the batch poller calls it
// directly), not merely an internal called only by its wrapper
// `drainQueueAction`.
//
// The mocking style mirrors tests/authz-actions-toolkit.test.ts: mock the
// dependencies, assert the guarded function never reaches them. Here the
// "service it must not reach" also includes `createServiceSupabase` itself,
// so a missing or misplaced guard fails the test loudly instead of quietly
// returning a plausible-looking success.

const deny = { ok: false as const, error: "You do not have permission to do that." };

vi.mock("@/lib/authz/server", () => ({
  checkPermission: vi.fn(),
  checkSiteAccess: vi.fn(),
  isDenied: (x: unknown) => typeof x === "object" && x !== null && (x as { ok?: boolean }).ok === false,
  requireViewer: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", email: "u@example.com" })),
  createServiceSupabase: vi.fn(() => { throw new Error("must not reach the database"); }),
}));

import { checkPermission, checkSiteAccess } from "@/lib/authz/server";
import { runSecurityScanAction } from "@/app/(dashboard)/sites/[id]/security-actions";
import { runSeoScanAction } from "@/app/(dashboard)/sites/[id]/seo-actions";
import {
  saveGeoGridConfigAction, runGeoGridAction, dismissFailedGeoGridRunsAction,
} from "@/app/(dashboard)/sites/[id]/geogrid-actions";
import { generateReportAction, revokeReportAction } from "@/app/(dashboard)/sites/[id]/reports-actions";
import { processQueueNowAction, drainQueueAction } from "@/app/(dashboard)/queue-actions";

const viewer = { id: "u1", email: "u@example.com", role: "developer", permissions: new Set(), grants: new Map() };

beforeEach(() => {
  vi.mocked(checkPermission).mockReset();
  vi.mocked(checkSiteAccess).mockReset();
});

describe("permission gates", () => {
  it.each([
    ["runSecurityScanAction", () => runSecurityScanAction("s1")],
    ["runSeoScanAction", () => runSeoScanAction("s1")],
    ["runGeoGridAction", () => runGeoGridAction("s1")],
    ["dismissFailedGeoGridRunsAction", () => dismissFailedGeoGridRunsAction("s1")],
    ["revokeReportAction", () => revokeReportAction("s1", "r1")],
    // Both queue entry points: processQueueNowAction is an exported helper and
    // therefore its own public endpoint, not merely an internal function.
    ["processQueueNowAction", () => processQueueNowAction()],
    ["drainQueueAction", () => drainQueueAction("/sites/s1/geogrid")],
  ])("%s refuses without its permission", async (_name, call) => {
    vi.mocked(checkPermission).mockResolvedValue(deny);
    vi.mocked(checkSiteAccess).mockResolvedValue(viewer as never);
    const res = await call();
    expect(res.ok).toBe(false);
  });

  it("each action asks for the permission the spec assigns it", async () => {
    vi.mocked(checkPermission).mockResolvedValue(deny);
    vi.mocked(checkSiteAccess).mockResolvedValue(viewer as never);
    for (const [call, expected] of [
      [() => runSecurityScanAction("s1"), "security.run"],
      [() => runSeoScanAction("s1"), "seo.run"],
      [() => saveGeoGridConfigAction("s1", null, new FormData()), "geogrid.manage"],
      [() => dismissFailedGeoGridRunsAction("s1"), "geogrid.manage"],
      [() => generateReportAction("s1", null, new FormData()), "reports.generate"],
      [() => revokeReportAction("s1", "r1"), "reports.manage"],
      [() => processQueueNowAction(), "queue.process"],
    ] as const) {
      vi.mocked(checkPermission).mockClear();
      await call();
      expect(vi.mocked(checkPermission).mock.calls[0][0]).toBe(expected);
    }
  });
});

describe("site scoping", () => {
  it("refuses a site-scoped action when the permission holds but the site does not", async () => {
    vi.mocked(checkPermission).mockResolvedValue(viewer as never);
    vi.mocked(checkSiteAccess).mockResolvedValue(deny);
    const res = await runSecurityScanAction("s-not-mine");
    expect(res.ok).toBe(false);
  });

  it("does not site-scope the queue actions — the queue is global", async () => {
    vi.mocked(checkPermission).mockResolvedValue(viewer as never);
    vi.mocked(checkSiteAccess).mockResolvedValue(deny);
    await processQueueNowAction();
    expect(vi.mocked(checkSiteAccess)).not.toHaveBeenCalled();
  });
});
