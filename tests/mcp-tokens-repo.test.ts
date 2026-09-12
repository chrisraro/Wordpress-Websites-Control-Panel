import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseTokensRepo } from "@/services/tokens/repo";

// supabaseTokensRepo is the only Supabase-touching code in the tokens
// feature, and findByHash runs on every single MCP authentication request.
// These tests pin: the exact column list each method selects (a wrong list
// here either breaks auth or leaks columns nothing currently catches),
// findByHash's null-not-undefined miss, the filter/order shape of
// listForUser, and that every method surfaces a Supabase query error by
// throwing with the error's own message rather than swallowing it.

function fakeDb(result: { data?: unknown; error?: { message: string } | null }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder = {
    insert(...args: unknown[]) { calls.push({ method: "insert", args }); return builder; },
    select(...args: unknown[]) { calls.push({ method: "select", args }); return builder; },
    update(...args: unknown[]) { calls.push({ method: "update", args }); return builder; },
    eq(...args: unknown[]) { calls.push({ method: "eq", args }); return builder; },
    order(...args: unknown[]) { calls.push({ method: "order", args }); return builder; },
    single() {
      calls.push({ method: "single", args: [] });
      return Promise.resolve({ data: result.data, error: result.error ?? null });
    },
    maybeSingle() {
      calls.push({ method: "maybeSingle", args: [] });
      // No `?? null` here: this must return `result.data` exactly as given
      // (including `undefined`) so findByHash's own `?? null` guard is what
      // the "returns null, not undefined" test actually exercises.
      return Promise.resolve({ data: result.data, error: result.error ?? null });
    },
    then(onFulfilled: (v: { data: unknown; error: unknown }) => unknown) {
      return Promise
        .resolve({ data: result.data ?? null, error: result.error ?? null })
        .then(onFulfilled);
    },
  };
  const db = {
    from(table: string) { calls.push({ method: "from", args: [table] }); return builder; },
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe("supabaseTokensRepo.findByHash", () => {
  it("queries api_tokens, filters on token_hash, and selects exactly the auth columns", async () => {
    const { db, calls } = fakeDb({ data: null });
    await supabaseTokensRepo(db).findByHash("hash-abc");

    expect(calls[0]).toEqual({ method: "from", args: ["api_tokens"] });
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: "select", args: ["id,user_id,read_only,expires_at,revoked_at"] },
        { method: "eq", args: ["token_hash", "hash-abc"] },
      ]),
    );
  });

  it("returns null, not undefined, when no row matches", async () => {
    const { db } = fakeDb({ data: undefined });
    const result = await supabaseTokensRepo(db).findByHash("missing-hash");

    expect(result).toBeNull();
    expect(result === undefined).toBe(false);
  });

  it("throws with the Supabase error's message when the query errors", async () => {
    const { db } = fakeDb({ error: { message: "connection reset" } });
    await expect(supabaseTokensRepo(db).findByHash("hash-abc"))
      .rejects.toThrow("connection reset");
  });
});

describe("supabaseTokensRepo.listForUser", () => {
  it("filters on user_id and orders by created_at descending", async () => {
    const { db, calls } = fakeDb({ data: [] });
    await supabaseTokensRepo(db).listForUser("user-1");

    expect(calls[0]).toEqual({ method: "from", args: ["api_tokens"] });
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["user_id", "user-1"] },
        { method: "order", args: ["created_at", { ascending: false }] },
      ]),
    );
  });

  it("throws with the Supabase error's message when the query errors", async () => {
    const { db } = fakeDb({ error: { message: "listForUser boom" } });
    await expect(supabaseTokensRepo(db).listForUser("user-1"))
      .rejects.toThrow("listForUser boom");
  });
});

describe("supabaseTokensRepo.insert", () => {
  it("returns the new row's id", async () => {
    const { db } = fakeDb({ data: { id: "tok-1" } });
    const result = await supabaseTokensRepo(db).insert({
      user_id: "user-1", name: "Claude Code", token_hash: "hash-abc",
      token_prefix: "wpcp_XYZ", read_only: false, expires_at: null,
    });

    expect(result).toEqual({ id: "tok-1" });
  });

  it("throws with the Supabase error's message when the query errors", async () => {
    const { db } = fakeDb({ error: { message: "insert boom" } });
    await expect(supabaseTokensRepo(db).insert({
      user_id: "user-1", name: "Claude Code", token_hash: "hash-abc",
      token_prefix: "wpcp_XYZ", read_only: false, expires_at: null,
    })).rejects.toThrow("insert boom");
  });
});

describe("supabaseTokensRepo.revoke", () => {
  it("sets revoked_at to a timestamp, not a boolean or true", async () => {
    const { db, calls } = fakeDb({ error: null });
    await supabaseTokensRepo(db).revoke("tok-1");

    const update = calls.find((c) => c.method === "update");
    expect(update).toBeDefined();
    const payload = update!.args[0] as { revoked_at: unknown };
    expect(typeof payload.revoked_at).toBe("string");
    expect(payload.revoked_at).not.toBe(true);
    expect(Number.isNaN(new Date(payload.revoked_at as string).getTime())).toBe(false);
    expect(calls).toEqual(
      expect.arrayContaining([{ method: "eq", args: ["id", "tok-1"] }]),
    );
  });

  it("throws with the Supabase error's message when the query errors", async () => {
    const { db } = fakeDb({ error: { message: "revoke boom" } });
    await expect(supabaseTokensRepo(db).revoke("tok-1")).rejects.toThrow("revoke boom");
  });
});

describe("supabaseTokensRepo.stampUsed", () => {
  it("sets last_used_at to the ISO string it was passed", async () => {
    const { db, calls } = fakeDb({ error: null });
    await supabaseTokensRepo(db).stampUsed("tok-1", "2026-09-12T00:00:00.000Z");

    const update = calls.find((c) => c.method === "update");
    expect(update).toEqual({
      method: "update", args: [{ last_used_at: "2026-09-12T00:00:00.000Z" }],
    });
    expect(calls).toEqual(
      expect.arrayContaining([{ method: "eq", args: ["id", "tok-1"] }]),
    );
  });

  it("throws with the Supabase error's message when the query errors", async () => {
    const { db } = fakeDb({ error: { message: "stampUsed boom" } });
    await expect(supabaseTokensRepo(db).stampUsed("tok-1", "2026-09-12T00:00:00.000Z"))
      .rejects.toThrow("stampUsed boom");
  });
});

describe("supabaseTokensRepo.getOwner", () => {
  it("throws with the Supabase error's message when the query errors", async () => {
    const { db } = fakeDb({ error: { message: "getOwner boom" } });
    await expect(supabaseTokensRepo(db).getOwner("tok-1")).rejects.toThrow("getOwner boom");
  });
});
