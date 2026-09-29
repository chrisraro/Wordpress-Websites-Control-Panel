import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow, JobType } from "@/services/jobs/types";
import type { Viewer } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";
import { buildJobHandlers } from "@/services/jobs/handlers";
import { NonRetryableError } from "@/services/jobs/service";

// Security finding (audit 2026-09-29, open 8): queued plugin_install,
// bulk_manage, update_all_plugins and harden jobs ran with the authority the
// actor had when the job was enqueued. A user whose permission or site grant
// was revoked in between still had their queued work act on the live site.
// The handler now re-reads the actor and requires what the enqueuing action
// required -- wp_toolkit.manage plus a manage grant on the job's site.

const installPluginMock = vi.fn(async (..._a: unknown[]) => ({ ok: true, output: "Installed" }));
const manageSiteMock = vi.fn(async (..._a: unknown[]) => ({ ok: true, output: "Done" }));
const hardenSiteMock = vi.fn(async (..._a: unknown[]) => ({ results: [], error: undefined }));
const securityScanMock = vi.fn(async (..._a: unknown[]) => undefined);

vi.mock("@/services/marketplace/install", () => ({ installPlugin: (...a: unknown[]) => installPluginMock(...a) }));
vi.mock("@/services/themes/install", () => ({ installTheme: vi.fn() }));
vi.mock("@/services/manage/service", () => ({ manageSite: (...a: unknown[]) => manageSiteMock(...a) }));
vi.mock("@/services/security/harden", () => ({
  hardenSite: (...a: unknown[]) => hardenSiteMock(...a),
  hardeningPlan: () => ["disable_file_edit"],
}));
vi.mock("@/services/security/scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/security/scan")>()),
  securityScan: (...a: unknown[]) => securityScanMock(...a),
}));
vi.mock("@/services/security/repo", () => ({
  supabaseSecurityRepo: () => ({ latestChecks: async () => ({ runAt: "x", checks: [] }) }),
}));

const SITE = "site-1";
const db = {
  storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://x" }, error: null }) }) },
  from() { throw new Error("no direct db access expected"); },
} as unknown as SupabaseClient;

function viewer(perms: AppPermission[], grants: [string, "read" | "manage"][]): Viewer {
  return { id: "user-1", email: null, role: "operator" as Viewer["role"], permissions: new Set(perms), grants: new Map(grants) };
}

const PAYLOADS: Record<string, Record<string, unknown>> = {
  plugin_install: { source: { kind: "wporg", slug: "akismet" }, activate: false, actor: "user-1" },
  // backup: "skip" -- the pre-update backup gate is tested in backup-gate.test.ts.
  bulk_manage: { kind: "update", target: "plugin", id: "akismet/akismet.php", actor: "user-1", backup: "skip" },
  update_all_plugins: { actor: "user-1", backup: "skip" },
  harden: { actor: "user-1" },
};

function job(type: string): JobRow {
  return {
    id: "job-1", type: type as JobType, site_id: SITE, batch_id: null, payload: PAYLOADS[type],
    status: "running", attempts: 1, scheduled_for: new Date(0).toISOString(),
    last_error: null, dismissed_at: null, finished_at: null,
  };
}

const acted = () =>
  installPluginMock.mock.calls.length + manageSiteMock.mock.calls.length + hardenSiteMock.mock.calls.length;

beforeEach(() => {
  installPluginMock.mockClear(); manageSiteMock.mockClear(); hardenSiteMock.mockClear();
});

describe.each(Object.keys(PAYLOADS))("%s handler re-checks the actor", (type) => {
  const run = (loadActor: (id: string) => Promise<Viewer | null>) =>
    buildJobHandlers(db, { loadActor })[type as JobType]!({ job: job(type) });

  it("runs when the actor still holds the permission and a manage grant", async () => {
    const loadActor = vi.fn(async () => viewer(["wp_toolkit.manage"], [[SITE, "manage"]]));
    await run(loadActor);
    expect(loadActor).toHaveBeenCalledWith("user-1");
    expect(acted()).toBe(1);
  });

  it("refuses, without retry, when the permission was revoked", async () => {
    const err = await run(async () => viewer([], [[SITE, "manage"]])).catch((e) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.message).toMatch(/actor no longer authorized/);
    expect(acted()).toBe(0);
  });

  it("refuses when the site grant was revoked or downgraded to read", async () => {
    for (const grants of [[], [[SITE, "read"]]] as [string, "read" | "manage"][][]) {
      const err = await run(async () => viewer(["wp_toolkit.manage"], grants)).catch((e) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
    }
    expect(acted()).toBe(0);
  });

  it("refuses when the actor no longer exists or has no role", async () => {
    const err = await run(async () => null).catch((e) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(acted()).toBe(0);
  });

  it("retries, rather than fails, when the actor's access cannot be read", async () => {
    const err = await run(async () => { throw new Error("could not read the queuing user's access"); })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    expect(acted()).toBe(0);
  });
});

describe("system jobs without an actor are unaffected", () => {
  it("vuln_feed_refresh never loads an actor", async () => {
    const loadActor = vi.fn(async () => null);
    const handlers = buildJobHandlers(db, { loadActor });
    // The handler itself may fail on the fake db; what matters is that no
    // actor lookup gates it.
    await handlers.vuln_feed_refresh!({ job: { ...job("harden"), type: "vuln_feed_refresh", site_id: null, payload: {} } })
      .catch(() => undefined);
    expect(loadActor).not.toHaveBeenCalled();
  });
});
