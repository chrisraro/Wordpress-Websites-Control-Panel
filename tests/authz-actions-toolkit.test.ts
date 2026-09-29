import { describe, it, expect, vi, beforeEach } from "vitest";

// These server actions are the phase-9a enforcement points for connecting a
// site and for every wp_toolkit/marketplace mutation. Before this task every
// exported action here succeeded for any authenticated user regardless of
// role or site grant — including `runConnectionTest`, an exported helper
// that is a publicly invokable endpoint in its own right, not merely an
// internal called only by its wrapper `testConnectionAction`.
//
// The mocking style mirrors tests/jobs-handlers.test.ts: mock the
// dependencies, assert the guarded function never reaches them. Here the
// "service it must not reach" also includes `createServiceSupabase` itself
// and the underlying domain service — mocked to throw — so a missing or
// misplaced guard fails the test loudly instead of quietly returning a
// plausible-looking success.

vi.mock("@/lib/supabase/server", () => ({
  requireUser: () => Promise.resolve({ id: "u1", email: "u1@example.com" }),
  createServiceSupabase: () => {
    throw new Error("createServiceSupabase must not be called when a guard denies access");
  },
}));

const DENIED = { ok: false, error: "You do not have permission to do that." };

const checkPermissionMock = vi.fn();
const checkSiteAccessMock = vi.fn();
const getViewerMock = vi.fn();

vi.mock("@/lib/authz/server", () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
  checkSiteAccess: (...args: unknown[]) => checkSiteAccessMock(...args),
  getViewer: (...args: unknown[]) => getViewerMock(...args),
  isDenied: (x: unknown): boolean =>
    typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false,
}));

const FAKE_VIEWER = {
  id: "u1", email: "u1@example.com", role: "developer",
  permissions: new Set(), grants: new Map(),
};

// Every domain service an action could reach past its guard. Throwing makes
// a missing check fail the test with a clear "X must not be called" message
// rather than an assertion mismatch that could be misread as a plumbing bug.
vi.mock("@/services/manage/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/manage/service")>();
  return {
    ...actual,
    manageSite: () => { throw new Error("manageSite must not be called when denied"); },
  };
});
vi.mock("@/services/inventory/service", () => ({
  refreshSnapshot: () => { throw new Error("refreshSnapshot must not be called when denied"); },
}));
vi.mock("@/services/sites/service", () => ({
  testSiteConnection: () => { throw new Error("testSiteConnection must not be called when denied"); },
}));
vi.mock("@/services/childtheme/service", () => ({
  createChildTheme: () => { throw new Error("createChildTheme must not be called when denied"); },
}));
vi.mock("@/services/themes/install", () => ({
  installTheme: () => { throw new Error("installTheme must not be called when denied"); },
}));
vi.mock("@/services/bulk/service", () => ({
  enqueueBulk: () => { throw new Error("enqueueBulk must not be called when denied"); },
}));
vi.mock("@/services/jobs/service", () => ({
  enqueueBatch: () => { throw new Error("enqueueBatch must not be called when denied"); },
}));
vi.mock("@/lib/adapters/wporg", () => ({
  searchThemes: () => { throw new Error("searchThemes must not be called when denied"); },
  popularThemes: () => { throw new Error("popularThemes must not be called when denied"); },
}));

// Imported after the mocks above so each action module picks up the mocked
// dependencies rather than the real Supabase/service modules.
import { createSite } from "@/app/(dashboard)/sites/new/actions";
import { runConnectionTest, testConnectionAction } from "@/app/(dashboard)/sites/[id]/actions";
import {
  manageAction, refreshInventoryAction, setOriginAction,
} from "@/app/(dashboard)/sites/[id]/manage-actions";
import { bulkAction } from "@/app/(dashboard)/sites/[id]/bulk-actions";
import { createChildThemeAction } from "@/app/(dashboard)/sites/[id]/child-theme-actions";
import {
  installThemeAction, prepareThemeUploadAction, searchWpThemesAction,
} from "@/app/(dashboard)/sites/[id]/themes/theme-actions";
import { createInstallBatchAction, prepareUploadAction } from "@/app/(dashboard)/marketplace/actions";

function formData(entries: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  checkPermissionMock.mockReset();
  checkSiteAccessMock.mockReset();
  getViewerMock.mockReset();
});

describe("createSite", () => {
  it("is refused without sites.manage", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await createSite(undefined, formData({
      name: "Site", url: "https://example.com", wpUsername: "admin", appPassword: "password1234",
    }));
    expect(result).toEqual(DENIED);
    expect(checkPermissionMock).toHaveBeenCalledWith("sites.manage");
  });
});

// Security finding: the site URL accepted any z.string().url() -- http://
// (application password in cleartext) or a private/loopback host (SSRF) --
// and the origin override accepted any IP literal. Both are refused before
// anything reaches the database. Literal IPs keep these tests off real DNS.
describe("createSite URL guard", () => {
  const fields = { name: "Site", wpUsername: "admin", appPassword: "password1234", environment: "staging" };

  it("refuses an http:// site URL", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    const result = await createSite(undefined, formData({ ...fields, url: "http://8.8.8.8" }));
    expect(result).toEqual({ error: "The site URL must start with https://" });
  });

  it.each(["https://127.0.0.1", "https://169.254.169.254", "https://10.0.0.5", "https://localhost", "https://[::1]"])(
    "refuses a private/loopback site URL %s",
    async (url) => {
      checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
      const result = await createSite(undefined, formData({ ...fields, url }));
      expect(result).toMatchObject({ error: expect.stringMatching(/private or local/) });
    },
  );
});

describe("setOriginAction IP guard", () => {
  it.each(["127.0.0.1", "10.0.0.5", "192.168.1.10", "169.254.169.254", "::1", "fd00::1", "100.64.1.1"])(
    "refuses a private origin IP %s",
    async (ip) => {
      checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
      checkSiteAccessMock.mockResolvedValue(FAKE_VIEWER);
      const result = await setOriginAction("site-1", null, formData({ origin_ip: ip, origin_sni: "example.com" }));
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/private or local/) });
    },
  );
});

describe("runConnectionTest (exported helper)", () => {
  it("is refused on its own when sites.manage is missing, without calling testSiteConnection", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await runConnectionTest("site-1");
    expect(result).toEqual({ ok: false, status: "disabled", error: DENIED.error });
    expect(checkSiteAccessMock).not.toHaveBeenCalled();
  });

  it("is refused when the permission holds but site access does not", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockResolvedValue(DENIED);
    const result = await runConnectionTest("site-1");
    expect(result).toEqual({ ok: false, status: "disabled", error: DENIED.error });
  });
});

describe("testConnectionAction (wrapper)", () => {
  it("inherits the guard from runConnectionTest and is refused", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await testConnectionAction("site-1", null, formData());
    expect(result).toEqual({ ok: false, error: DENIED.error });
  });
});

describe("manageAction", () => {
  it("is refused without wp_toolkit.manage", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await manageAction("site-1", { kind: "activate", target: "plugin", file: "x.php" } as never);
    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).not.toHaveBeenCalled();
  });

  it("is refused when the permission holds but there is no site access", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockResolvedValue(DENIED);
    const result = await manageAction("site-1", { kind: "activate", target: "plugin", file: "x.php" } as never);
    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).toHaveBeenCalledWith("site-1", "manage");
  });
});

describe("refreshInventoryAction", () => {
  // Finding 1 of the final whole-branch review: a site grant says *which*
  // sites; a permission says *what* may be done on them. Every other
  // wp_toolkit write in this file (manageAction, bulkAction below,
  // installThemeAction, ...) requires both -- this was the one exception,
  // and a `manage` grant alone is exactly the level a client's own
  // dashboard can offer (site-grants.tsx).
  it("is refused without wp_toolkit.manage", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await refreshInventoryAction("site-1");
    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).not.toHaveBeenCalled();
  });

  it("is refused with only a read grant (requires manage)", async () => {
    // checkSiteAccess is mocked at the boundary: simulating "read-only grant"
    // means the mock denies when asked for "manage", exactly as the real
    // canAccessSite would for a client holding only a read-level grant.
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockImplementation((_siteId: string, min?: string) =>
      Promise.resolve(min === "manage" ? DENIED : FAKE_VIEWER));
    const result = await refreshInventoryAction("site-1");
    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).toHaveBeenCalledWith("site-1", "manage");
  });
});

describe("bulkAction", () => {
  it("is refused without wp_toolkit.manage", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await bulkAction("site-1", "activate", "plugin", ["akismet/akismet.php"]);
    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).not.toHaveBeenCalled();
  });

  it("is refused when the permission holds but there is no site access", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockResolvedValue(DENIED);
    const result = await bulkAction("site-1", "activate", "plugin", ["akismet/akismet.php"]);
    expect(result).toEqual(DENIED);
  });
});

describe("createChildThemeAction", () => {
  it("is refused without wp_toolkit.manage", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await createChildThemeAction("site-1", true);
    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).not.toHaveBeenCalled();
  });

  it("is refused when the permission holds but there is no site access", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockResolvedValue(DENIED);
    const result = await createChildThemeAction("site-1", true);
    expect(result).toEqual(DENIED);
  });
});

describe("installThemeAction", () => {
  it("is refused without wp_toolkit.manage", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await installThemeAction("site-1", null, formData({ source: "wporg", slug: "storefront" }));
    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).not.toHaveBeenCalled();
  });

  it("is refused when the permission holds but there is no site access", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockResolvedValue(DENIED);
    const result = await installThemeAction("site-1", null, formData({ source: "wporg", slug: "storefront" }));
    expect(result).toEqual(DENIED);
  });
});

describe("prepareThemeUploadAction", () => {
  it("is refused without wp_toolkit.manage", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await prepareThemeUploadAction("site-1", "theme.zip");
    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).not.toHaveBeenCalled();
  });

  it("is refused when the permission holds but there is no site access", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockResolvedValue(DENIED);
    const result = await prepareThemeUploadAction("site-1", "theme.zip");
    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).toHaveBeenCalledWith("site-1", "manage");
  });
});

describe("searchWpThemesAction", () => {
  it("is refused for an unauthenticated caller", async () => {
    getViewerMock.mockResolvedValue(null);
    const result = await searchWpThemesAction("storefront");
    expect(result).toEqual({ ok: false, error: DENIED.error });
  });
});

describe("createInstallBatchAction", () => {
  it("is refused without wp_toolkit.manage", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await createInstallBatchAction({
      source: { kind: "wporg", slug: "akismet" }, siteIds: ["site-1"], activate: true,
    });
    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).not.toHaveBeenCalled();
  });

  // This is the invariant that keeps `prepareUploadAction` (below) safe to
  // leave permission-only: that action mints an upload URL with no siteId at
  // all, on the assumption that every site named in a later
  // `createInstallBatchAction` call is checked before the uploaded path is
  // consumed. Deleting this test removes the only thing pinning that
  // assumption in place.
  it("rejects the whole batch when one of two site ids is not granted, and enqueues nothing", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockImplementation((siteId: string) =>
      Promise.resolve(siteId === "site-2" ? DENIED : FAKE_VIEWER));

    const result = await createInstallBatchAction({
      source: { kind: "wporg", slug: "akismet" }, siteIds: ["site-1", "site-2"], activate: true,
    });

    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).toHaveBeenCalledWith("site-1", "manage");
    expect(checkSiteAccessMock).toHaveBeenCalledWith("site-2", "manage");
  });

  // Final whole-branch review, finding 1: this action installs/activates
  // plugin or theme code on a live WordPress site -- the same class of write
  // every sibling toolkit action (manageAction, bulkAction,
  // refreshInventoryAction) requires "manage" for. A `read` grant, which is
  // exactly the level the seeded matrix hands a `client`, must not be
  // enough.
  it("is refused with only a read grant (requires manage)", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockImplementation((_siteId: string, min?: string) =>
      Promise.resolve(min === "manage" ? DENIED : FAKE_VIEWER));

    const result = await createInstallBatchAction({
      source: { kind: "wporg", slug: "akismet" }, siteIds: ["site-1"], activate: true,
    });

    expect(result).toEqual(DENIED);
    expect(checkSiteAccessMock).toHaveBeenCalledWith("site-1", "manage");
  });

  // No happy-path test in this file lets the action actually enqueue (every
  // domain dependency is mocked to throw, by design). So "allowed with
  // manage" is proven the same way the file proves everything else: with a
  // manage grant the guard must not deny, meaning execution reaches
  // `createServiceSupabase` -- which the harness throws from specifically to
  // make "the guard was cleared" observable.
  it("clears the guard and reaches createServiceSupabase with a manage grant", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockImplementation((_siteId: string, min?: string) =>
      Promise.resolve(min === "manage" ? FAKE_VIEWER : DENIED));

    await expect(createInstallBatchAction({
      source: { kind: "wporg", slug: "akismet" }, siteIds: ["site-1"], activate: true,
    })).rejects.toThrow("createServiceSupabase must not be called when a guard denies access");

    expect(checkSiteAccessMock).toHaveBeenCalledWith("site-1", "manage");
  });
});

// Security finding: the source was only validated when its kind was
// "wporg" or "upload", so a forged { kind: "url", url } from a client call
// fell through both checks and was stored in the job payload, letting a
// wp_toolkit.manage holder install an arbitrary remote zip.
describe("createInstallBatchAction source kind", () => {
  it("rejects a forged url source before anything is enqueued", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockResolvedValue(FAKE_VIEWER);
    const result = await createInstallBatchAction({
      source: { kind: "url", url: "https://evil.example/x.zip", path: "x" } as never,
      siteIds: ["site-1"], activate: true,
    });
    expect(result).toEqual({ ok: false, error: "Invalid install source" });
  });

  it("rejects a missing source", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    checkSiteAccessMock.mockResolvedValue(FAKE_VIEWER);
    const result = await createInstallBatchAction({
      source: null as never, siteIds: ["site-1"], activate: true,
    });
    expect(result).toEqual({ ok: false, error: "Invalid install source" });
  });
});

describe("prepareUploadAction", () => {
  it("is refused without wp_toolkit.manage (no siteId travels with this call)", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await prepareUploadAction("plugin.zip");
    expect(result).toEqual(DENIED);
  });
});
