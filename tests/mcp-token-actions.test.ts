import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string },
  permission: "denied" as "denied" | "allowed",
  owners: {} as Record<string, string>,
  revoked: [] as string[],
  minted: [] as Record<string, unknown>[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: async () => state.user,
  createServiceSupabase: () => ({}),
  createServerSupabase: async () => ({}),
}));
vi.mock("@/lib/authz/server", () => ({
  checkPermission: async () =>
    state.permission === "allowed"
      ? { id: state.user.id, permissions: new Set(["users.manage"]) }
      : { ok: false, error: "You do not have permission to do that." },
  isDenied: (x: unknown) =>
    typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false,
}));
vi.mock("@/services/tokens/repo", () => ({
  supabaseTokensRepo: () => ({
    getOwner: async (id: string) => (state.owners[id] ? { user_id: state.owners[id] } : null),
    listForUser: async () => [],
  }),
}));
vi.mock("@/services/tokens/service", () => ({
  mintToken: async (_repo: unknown, input: Record<string, unknown>) => {
    state.minted.push(input);
    return { id: "tok-new", secret: "wpcp_brandnewsecret" };
  },
  listTokens: async () => [],
  revokeToken: async (_repo: unknown, id: string) => { state.revoked.push(id); },
}));

import { createTokenAction, revokeTokenAction } from "@/app/(dashboard)/users/[id]/token-actions";

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  state.user = { id: "u1" };
  state.permission = "denied";
  state.owners = {};
  state.revoked = [];
  state.minted = [];
});

describe("createTokenAction", () => {
  it("mints a token for the signed-in user and returns the secret once", async () => {
    const res = await createTokenAction("u1", null, form({ name: "Claude Code", expiry: "30d" }));
    expect(res.ok).toBe(true);
    expect(res.secret).toBe("wpcp_brandnewsecret");
    expect(state.minted).toEqual([
      { userId: "u1", name: "Claude Code", readOnly: false, expiry: "30d" },
    ]);
  });

  it("records the read-only flag when the checkbox is set", async () => {
    await createTokenAction("u1", null, form({ name: "n8n", expiry: "none", read_only: "on" }));
    expect(state.minted[0].readOnly).toBe(true);
  });

  it("refuses to mint a token for somebody else, even as an admin", async () => {
    state.permission = "allowed";
    const res = await createTokenAction("u2", null, form({ name: "x", expiry: "none" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/yourself/i);
    expect(state.minted).toEqual([]);
  });

  it("requires a name", async () => {
    const res = await createTokenAction("u1", null, form({ name: "  ", expiry: "none" }));
    expect(res.ok).toBe(false);
    expect(state.minted).toEqual([]);
  });

  it("rejects an unknown expiry rather than defaulting silently", async () => {
    const res = await createTokenAction("u1", null, form({ name: "x", expiry: "forever" }));
    expect(res.ok).toBe(false);
    expect(state.minted).toEqual([]);
  });
});

describe("revokeTokenAction", () => {
  it("lets a user revoke their own token", async () => {
    state.owners["tok-1"] = "u1";
    const res = await revokeTokenAction("tok-1");
    expect(res.ok).toBe(true);
    expect(state.revoked).toEqual(["tok-1"]);
  });

  it("refuses to revoke another user's token without users.manage", async () => {
    state.owners["tok-2"] = "u2";
    const res = await revokeTokenAction("tok-2");
    expect(res.ok).toBe(false);
    expect(state.revoked).toEqual([]);
  });

  it("lets users.manage revoke anyone's token", async () => {
    state.owners["tok-2"] = "u2";
    state.permission = "allowed";
    const res = await revokeTokenAction("tok-2");
    expect(res.ok).toBe(true);
    expect(state.revoked).toEqual(["tok-2"]);
  });

  it("reports a token that does not exist", async () => {
    const res = await revokeTokenAction("tok-missing");
    expect(res.ok).toBe(false);
    expect(state.revoked).toEqual([]);
  });
});
