import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

// setProductionPairAction edits two site records' relationship, so it is
// held to sites.manage plus a `manage` grant on BOTH sites -- the staging
// copy being edited and the production site it will point at (and, when a
// pairing is replaced or cleared, the production site it pointed at
// before). Denied paths must never reach the service-role client.

const createServiceSupabaseMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  requireUser: () => Promise.resolve({ id: "u1", email: "u1@example.com" }),
  createServiceSupabase: () => createServiceSupabaseMock(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const DENIED = { ok: false, error: "You do not have permission to do that." };
const checkPermissionMock = vi.fn();
const checkSiteAccessMock = vi.fn();
vi.mock("@/lib/authz/server", () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
  checkSiteAccess: (...args: unknown[]) => checkSiteAccessMock(...args),
  isDenied: (x: unknown): boolean =>
    typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false,
}));

const VIEWER = { id: "u1", email: null, role: "developer", permissions: new Set(), grants: new Map() };

const sitesById = new Map<string, unknown>();
const insertActivity = vi.fn();
vi.mock("@/services/sites/repo", () => ({
  supabaseSitesRepo: () => ({
    getSite: (id: string) => Promise.resolve(sitesById.get(id) ?? null),
    insertActivity: (e: unknown) => insertActivity(e),
  }),
}));

let currentPair: string | null = null;
const setProductionSiteId = vi.fn();
vi.mock("@/services/sites/pairing-repo", () => ({
  supabasePairingRepo: () => ({
    getProductionSiteId: () => Promise.resolve(currentPair),
    setProductionSiteId: (id: string, p: string | null) => setProductionSiteId(id, p),
  }),
}));

import { setProductionPairAction } from "@/app/(dashboard)/sites/[id]/pairing-actions";

const STAGING = randomUUID();
const PROD = randomUUID();
const OLD_PROD = randomUUID();

function row(id: string, environment: "production" | "staging", name: string) {
  return {
    id, name, url: `https://${name}.example.com`, status: "connected", environment,
    client_label: null, capabilities: { abilities: [] }, created_at: "", updated_at: "",
  };
}

function fd(value: string): FormData {
  const f = new FormData();
  f.set("production_site_id", value);
  return f;
}

beforeEach(() => {
  checkPermissionMock.mockReset();
  checkSiteAccessMock.mockReset();
  createServiceSupabaseMock.mockReset();
  createServiceSupabaseMock.mockImplementation(() => {
    throw new Error("createServiceSupabase must not be called when denied");
  });
  setProductionSiteId.mockReset();
  insertActivity.mockReset();
  currentPair = null;
  sitesById.clear();
  sitesById.set(STAGING, row(STAGING, "staging", "acme-staging"));
  sitesById.set(PROD, row(PROD, "production", "acme"));
  sitesById.set(OLD_PROD, row(OLD_PROD, "production", "other"));
});

function allowAll() {
  checkPermissionMock.mockResolvedValue(VIEWER);
  checkSiteAccessMock.mockResolvedValue(VIEWER);
  createServiceSupabaseMock.mockReturnValue({});
}

describe("setProductionPairAction authz", () => {
  it("is refused without sites.manage", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    expect(await setProductionPairAction(STAGING, null, fd(PROD))).toEqual(DENIED);
    expect(checkPermissionMock).toHaveBeenCalledWith("sites.manage");
    expect(setProductionSiteId).not.toHaveBeenCalled();
  });

  it("is refused without a manage grant on the staging site", async () => {
    checkPermissionMock.mockResolvedValue(VIEWER);
    checkSiteAccessMock.mockImplementation((id: string) =>
      Promise.resolve(id === STAGING ? DENIED : VIEWER));
    expect(await setProductionPairAction(STAGING, null, fd(PROD))).toEqual(DENIED);
    expect(checkSiteAccessMock).toHaveBeenCalledWith(STAGING, "manage");
  });

  it("is refused without a manage grant on the production site", async () => {
    checkPermissionMock.mockResolvedValue(VIEWER);
    checkSiteAccessMock.mockImplementation((id: string) =>
      Promise.resolve(id === PROD ? DENIED : VIEWER));
    expect(await setProductionPairAction(STAGING, null, fd(PROD))).toEqual(DENIED);
    expect(checkSiteAccessMock).toHaveBeenCalledWith(PROD, "manage");
    expect(createServiceSupabaseMock).not.toHaveBeenCalled();
  });

  it("is refused when replacing a pairing whose old production site the viewer cannot manage", async () => {
    allowAll();
    currentPair = OLD_PROD;
    checkSiteAccessMock.mockImplementation((id: string) =>
      Promise.resolve(id === OLD_PROD ? DENIED : VIEWER));
    expect(await setProductionPairAction(STAGING, null, fd(PROD))).toEqual(DENIED);
    expect(setProductionSiteId).not.toHaveBeenCalled();
  });

  it("is refused when clearing a pairing whose production site the viewer cannot manage", async () => {
    allowAll();
    currentPair = OLD_PROD;
    checkSiteAccessMock.mockImplementation((id: string) =>
      Promise.resolve(id === OLD_PROD ? DENIED : VIEWER));
    expect(await setProductionPairAction(STAGING, null, fd(""))).toEqual(DENIED);
    expect(setProductionSiteId).not.toHaveBeenCalled();
  });
});

describe("setProductionPairAction validation", () => {
  it("rejects a value that is not a site id, before touching the database", async () => {
    checkPermissionMock.mockResolvedValue(VIEWER);
    checkSiteAccessMock.mockResolvedValue(VIEWER);
    const result = await setProductionPairAction(STAGING, null, fd("'; drop table sites; --"));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Choose a production site/) });
    expect(createServiceSupabaseMock).not.toHaveBeenCalled();
  });

  it("rejects pairing a site with itself", async () => {
    allowAll();
    const result = await setProductionPairAction(STAGING, null, fd(STAGING));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/itself/) });
    expect(setProductionSiteId).not.toHaveBeenCalled();
  });

  it("rejects a staging target", async () => {
    allowAll();
    const other = randomUUID();
    sitesById.set(other, row(other, "staging", "acme-staging2"));
    const result = await setProductionPairAction(STAGING, null, fd(other));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not marked production/) });
    expect(setProductionSiteId).not.toHaveBeenCalled();
  });

  it("rejects pairing FROM a production site", async () => {
    allowAll();
    const result = await setProductionPairAction(OLD_PROD, null, fd(PROD));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Only a staging site/) });
  });
});

describe("setProductionPairAction success", () => {
  it("stores the pairing and logs it", async () => {
    allowAll();
    expect(await setProductionPairAction(STAGING, null, fd(PROD))).toEqual({ ok: true });
    expect(setProductionSiteId).toHaveBeenCalledWith(STAGING, PROD);
    expect(insertActivity).toHaveBeenCalledWith(expect.objectContaining({
      actor: "u1", site_id: STAGING, action: "site.pair",
    }));
  });

  it("clears the pairing when the value is empty", async () => {
    allowAll();
    currentPair = PROD;
    expect(await setProductionPairAction(STAGING, null, fd(""))).toEqual({ ok: true });
    expect(setProductionSiteId).toHaveBeenCalledWith(STAGING, null);
    expect(insertActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "site.unpair" }));
  });
});
