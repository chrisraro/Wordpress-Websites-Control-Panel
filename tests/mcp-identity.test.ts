import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { applyReadOnly, authenticateToken, PERMISSION_KIND } from "@/lib/authz/token";
import { hashToken } from "@/services/tokens/service";
import { APP_PERMISSIONS, type AppPermission } from "@/lib/authz/types";
import type { Viewer } from "@/lib/authz/decide";
import type { TokensRepo } from "@/services/tokens/repo";
import type { ApiTokenAuthRow } from "@/services/tokens/types";

function adminViewer(): Viewer {
  return {
    id: "u1",
    email: "a@example.com",
    role: "admin",
    permissions: new Set<AppPermission>([...APP_PERMISSIONS]),
    grants: new Map([["site-a", "manage"], ["site-b", "read"]]),
  };
}

function repoWith(row: ApiTokenAuthRow | null, stamped: string[] = []): TokensRepo {
  return {
    async insert() { throw new Error("not used"); },
    async findByHash() { return row; },
    async listForUser() { return []; },
    async getOwner() { return null; },
    async revoke() {},
    async stampUsed(id) { stamped.push(id); },
  };
}

describe("applyReadOnly", () => {
  it("strips every write permission and leaves exactly the read ones", () => {
    const ro = applyReadOnly(adminViewer());
    // With the current APP_PERMISSIONS, sites.view_all is the only permission
    // that is not a write, so it is the only one that may survive.
    expect([...ro.permissions]).toEqual(["sites.view_all"]);
  });

  it("downgrades every site grant to read", () => {
    const ro = applyReadOnly(adminViewer());
    expect([...ro.grants.entries()].sort()).toEqual([
      ["site-a", "read"], ["site-b", "read"],
    ]);
  });

  it("does not mutate the viewer it was given", () => {
    const v = adminViewer();
    applyReadOnly(v);
    expect(v.permissions.has("sites.manage")).toBe(true);
    expect(v.grants.get("site-a")).toBe("manage");
  });

  it("keeps identity fields", () => {
    const ro = applyReadOnly(adminViewer());
    expect(ro.id).toBe("u1");
    expect(ro.email).toBe("a@example.com");
    expect(ro.role).toBe("admin");
  });
});

describe("PERMISSION_KIND", () => {
  it("classifies every permission APP_PERMISSIONS currently has -- no more, no less", () => {
    // The Record type already forces every APP_PERMISSIONS entry to be
    // classified at compile time. This is the mirror case a type can't
    // catch: a permission removed from APP_PERMISSIONS but left as a stale
    // key here, which would silently widen or narrow applyReadOnly's output
    // without APP_PERMISSIONS itself showing any sign of it.
    expect(Object.keys(PERMISSION_KIND).sort()).toEqual([...APP_PERMISSIONS].sort());
  });
});

describe("authenticateToken", () => {
  const secret = "wpcp_testsecrettestsecrettestsecrettestsecre";
  const base: ApiTokenAuthRow = {
    id: "tok-1", user_id: "u1", read_only: false, expires_at: null, revoked_at: null,
  };
  const load = async () => adminViewer();

  it("resolves a valid token to a Viewer and stamps last_used_at", async () => {
    const stamped: string[] = [];
    const auth = await authenticateToken(secret, repoWith(base, stamped), load);
    expect(auth).not.toBeNull();
    expect(auth!.tokenId).toBe("tok-1");
    expect(auth!.readOnly).toBe(false);
    expect(auth!.viewer.permissions.has("sites.manage")).toBe(true);
    expect(stamped).toEqual(["tok-1"]);
  });

  it("looks the token up by its hash, never by the secret", async () => {
    let seen = "";
    const repo = { ...repoWith(base), async findByHash(h: string) { seen = h; return base; } };
    await authenticateToken(secret, repo as TokensRepo, load);
    expect(seen).toBe(hashToken(secret));
    expect(seen).not.toBe(secret);
  });

  it("rejects a revoked token", async () => {
    const row = { ...base, revoked_at: "2026-09-01T00:00:00.000Z" };
    expect(await authenticateToken(secret, repoWith(row), load)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const row = { ...base, expires_at: "2026-09-01T00:00:00.000Z" };
    const now = new Date("2026-09-12T00:00:00.000Z");
    expect(await authenticateToken(secret, repoWith(row), load, now)).toBeNull();
  });

  it("accepts a token whose expiry is still in the future", async () => {
    const row = { ...base, expires_at: "2026-10-01T00:00:00.000Z" };
    const now = new Date("2026-09-12T00:00:00.000Z");
    expect(await authenticateToken(secret, repoWith(row), load, now)).not.toBeNull();
  });

  it("rejects a token whose expiry is exactly now", async () => {
    // Pins the fail-closed boundary: expires_at <= now must reject, so a
    // later refactor can't flip <= to < with a green suite.
    const now = new Date("2026-09-12T00:00:00.000Z");
    const row = { ...base, expires_at: now.toISOString() };
    expect(await authenticateToken(secret, repoWith(row), load, now)).toBeNull();
  });

  it("rejects a token with an unparseable expires_at", async () => {
    // Defence in depth: the column is timestamptz so this shouldn't happen
    // in practice, but new Date("garbage").getTime() is NaN, and NaN <= now
    // is false, which would otherwise treat the token as not expired.
    const row = { ...base, expires_at: "garbage" };
    expect(await authenticateToken(secret, repoWith(row), load)).toBeNull();
  });

  it("rejects an unknown token", async () => {
    expect(await authenticateToken(secret, repoWith(null), load)).toBeNull();
  });

  it("rejects a token whose user has no role", async () => {
    const auth = await authenticateToken(secret, repoWith(base), async () => null);
    expect(auth).toBeNull();
  });

  it("applies read_only to the viewer when the token is read-only", async () => {
    const auth = await authenticateToken(secret, repoWith({ ...base, read_only: true }), load);
    expect(auth!.readOnly).toBe(true);
    expect([...auth!.viewer.permissions]).toEqual(["sites.view_all"]);
    expect([...auth!.viewer.grants.values()]).toEqual(["read", "read"]);
  });

  it("still authenticates when stamping last_used_at fails", async () => {
    const repo = {
      ...repoWith(base),
      async stampUsed() { throw new Error("db down"); },
    };
    const auth = await authenticateToken(secret, repo as TokensRepo, load);
    expect(auth).not.toBeNull();
  });
});
