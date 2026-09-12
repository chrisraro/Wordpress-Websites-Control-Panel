import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  hashToken, generateSecret, tokenPrefix, expiryToIso, mintToken, listTokensOrUnavailable,
} from "@/services/tokens/service";
import type { TokensRepo } from "@/services/tokens/repo";
import type { ApiTokenAuthRow, ApiTokenRow } from "@/services/tokens/types";

function fakeRepo() {
  const rows: (ApiTokenRow & { token_hash: string })[] = [];
  const repo: TokensRepo & { rows: typeof rows } = {
    rows,
    async insert(r) {
      const id = `tok-${rows.length + 1}`;
      rows.push({
        id, user_id: r.user_id, name: r.name, token_prefix: r.token_prefix,
        read_only: r.read_only, expires_at: r.expires_at, last_used_at: null,
        revoked_at: null, created_at: new Date().toISOString(), token_hash: r.token_hash,
      });
      return { id };
    },
    async findByHash(h) {
      const r = rows.find((x) => x.token_hash === h);
      return r ? ({ id: r.id, user_id: r.user_id, read_only: r.read_only,
        expires_at: r.expires_at, revoked_at: r.revoked_at } as ApiTokenAuthRow) : null;
    },
    async listForUser(u) { return rows.filter((r) => r.user_id === u); },
    async getOwner(id) {
      const r = rows.find((x) => x.id === id);
      return r ? { user_id: r.user_id } : null;
    },
    async revoke(id) {
      const r = rows.find((x) => x.id === id);
      if (r) r.revoked_at = new Date().toISOString();
    },
    async stampUsed(id, at) {
      const r = rows.find((x) => x.id === id);
      if (r) r.last_used_at = at;
    },
  };
  return repo;
}

describe("token secrets", () => {
  it("generates a wpcp_ secret of 32 random bytes in base64url", () => {
    const s = generateSecret();
    expect(s.startsWith("wpcp_")).toBe(true);
    // 32 bytes base64url with no padding is 43 characters.
    expect(s.slice(5)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(s);
  });

  it("hashes the WHOLE secret including the wpcp_ prefix", () => {
    const s = "wpcp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    expect(hashToken(s)).toBe(createHash("sha256").update(s).digest("hex"));
    // The hash must never be the secret, or the database would hold a usable key.
    expect(hashToken(s)).not.toBe(s);
    expect(hashToken(s)).toHaveLength(64);
  });

  it("takes the prefix from the first 8 characters", () => {
    expect(tokenPrefix("wpcp_XYZabc123")).toBe("wpcp_XYZ");
    expect(tokenPrefix("wpcp_XYZabc123")).toHaveLength(8);
  });
});

describe("expiry", () => {
  const now = new Date("2026-09-12T00:00:00.000Z");
  it("maps each choice to an absolute instant, or null for none", () => {
    expect(expiryToIso("none", now)).toBeNull();
    expect(expiryToIso("30d", now)).toBe("2026-10-12T00:00:00.000Z");
    expect(expiryToIso("90d", now)).toBe("2026-12-11T00:00:00.000Z");
    expect(expiryToIso("1y", now)).toBe("2027-09-12T00:00:00.000Z");
  });
});

describe("mintToken", () => {
  it("stores the hash and prefix, and returns the secret exactly once", async () => {
    const repo = fakeRepo();
    const { id, secret } = await mintToken(repo, {
      userId: "u1", name: "Claude Code", readOnly: false, expiry: "30d",
    });
    expect(id).toBe("tok-1");
    const stored = repo.rows[0];
    expect(stored.token_hash).toBe(hashToken(secret));
    expect(stored.token_prefix).toBe(secret.slice(0, 8));
    expect(stored.read_only).toBe(false);
    expect(stored.expires_at).not.toBeNull();
    // The secret itself must appear nowhere in the stored row.
    expect(JSON.stringify(stored)).not.toContain(secret);
    // And it must be findable by its hash, which is how authentication works.
    expect(await repo.findByHash(hashToken(secret))).not.toBeNull();
  });

  it("records read_only tokens as read_only", async () => {
    const repo = fakeRepo();
    await mintToken(repo, { userId: "u1", name: "n8n", readOnly: true, expiry: "none" });
    expect(repo.rows[0].read_only).toBe(true);
    expect(repo.rows[0].expires_at).toBeNull();
  });
});

describe("listTokensOrUnavailable", () => {
  // Final review, Fix 4: /users/[id] and /account read tokens through this
  // so a build that reaches production before migration 0021 (api_tokens)
  // is applied degrades to a hint instead of a 500 on a page that worked
  // before the feature existed.
  it("returns the rows and unavailable: false when the repo works", async () => {
    const repo = fakeRepo();
    await mintToken(repo, { userId: "u1", name: "Claude Code", readOnly: false, expiry: "30d" });
    const out = await listTokensOrUnavailable(repo, "u1");
    expect(out.unavailable).toBe(false);
    expect(out.tokens.map((t) => t.name)).toEqual(["Claude Code"]);
  });

  it("returns an empty list and unavailable: true when the repo throws, logging the error", async () => {
    const repo = fakeRepo();
    repo.listForUser = async () => {
      throw new Error('relation "public.api_tokens" does not exist');
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await listTokensOrUnavailable(repo, "u1");
      expect(out).toEqual({ tokens: [], unavailable: true });
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][1])).toContain("api_tokens");
    } finally {
      err.mockRestore();
    }
  });
});
