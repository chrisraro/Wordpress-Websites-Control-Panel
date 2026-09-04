import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { reconnectSite } from "@/services/sites/service";
import { McpAuthError, McpConnectionError } from "@/lib/mcp/errors";
import type { SitesRepo } from "@/services/sites/repo";

/**
 * The property under test is verify-before-store: a credential that does not
 * work must never replace one that might, and a failed attempt must leave the
 * site byte-for-byte as it was. Everything else here is secondary.
 */

beforeAll(() => {
  // encryptSecret needs a real 32-byte key; the value is irrelevant to these
  // assertions, only that encryption runs rather than throwing.
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

function repo(over: Partial<SitesRepo> = {}) {
  const calls = { updated: [] as unknown[], activity: [] as unknown[] };
  const base = {
    async getSite() {
      return {
        id: "site-1", name: "El Nido Guide Staging", url: "https://staging.elnidoguide.ph",
        status: "reconnect_needed", client_label: null,
        capabilities: { abilities: ["old/ability"] },
        created_at: "", updated_at: "",
      };
    },
    async updateSiteCredentials(_id: string, creds: unknown) { calls.updated.push(creds); },
    async insertActivity(e: unknown) { calls.activity.push(e); },
  } as unknown as SitesRepo;
  return { calls, repo: { ...base, ...over } as SitesRepo };
}

/** An MCP factory that connects and reports the abilities it was given. */
function mcpOk(abilities: string[]) {
  return async () => ({
    async discoverAbilities() { return { abilities: abilities.map((name) => ({ name })) }; },
    async close() {},
  }) as never;
}

/** An MCP factory that refuses the credential the way WordPress does. */
function mcpRejecting(err: Error) {
  return async () => { throw err; };
}

const deps = (r: SitesRepo, mcp: unknown) =>
  ({ repo: r, mcp, jobs: {} } as never);

const INPUT = { wpUsername: "admin", appPassword: "aaaa bbbb cccc dddd" };

describe("reconnectSite", () => {
  it("stores the credential and refreshes abilities once the connection proves good", async () => {
    const { calls, repo: r } = repo();
    const out = await reconnectSite(deps(r, mcpOk(["a/one", "a/two"])), "site-1", INPUT, "user-1");

    expect(out).toEqual({ ok: true, abilities: 2 });
    expect(calls.updated).toHaveLength(1);
    expect(calls.updated[0]).toMatchObject({
      wp_username: "admin",
      capabilities: { abilities: ["a/one", "a/two"] },
    });
  });

  it("encrypts the password rather than storing it as given", async () => {
    // The one thing that must never appear in the database in plaintext.
    const { calls, repo: r } = repo();
    await reconnectSite(deps(r, mcpOk(["a/one"])), "site-1", INPUT, "user-1");
    const stored = calls.updated[0] as { app_password_encrypted: string };
    expect(stored.app_password_encrypted).not.toContain(INPUT.appPassword);
    expect(stored.app_password_encrypted.length).toBeGreaterThan(0);
  });

  it("writes nothing when WordPress rejects the password", async () => {
    // The site keeps the credential it had. Replacing a possibly-good secret
    // with a known-bad one would turn a recoverable state into a worse one.
    const { calls, repo: r } = repo();
    await expect(
      reconnectSite(deps(r, mcpRejecting(new McpAuthError("401"))), "site-1", INPUT, "user-1"),
    ).rejects.toThrow(/rejected the application password/i);
    expect(calls.updated).toHaveLength(0);
    expect(calls.activity).toHaveLength(0);
  });

  it("writes nothing when the site is unreachable", async () => {
    const { calls, repo: r } = repo();
    await expect(
      reconnectSite(deps(r, mcpRejecting(new McpConnectionError("ETIMEDOUT"))), "site-1", INPUT, "user-1"),
    ).rejects.toThrow(/could not reach/i);
    expect(calls.updated).toHaveLength(0);
  });

  it("refuses a site that does not exist", async () => {
    const { repo: r } = repo({ getSite: async () => null } as Partial<SitesRepo>);
    await expect(
      reconnectSite(deps(r, mcpOk([])), "nope", INPUT, "user-1"),
    ).rejects.toThrow(/not found/i);
  });

  it("logs the username but never the password", async () => {
    // "Who is this site connecting as" is worth answering later; the secret
    // is not, and activity_log is readable by more surfaces than the
    // credential columns are.
    const { calls, repo: r } = repo();
    await reconnectSite(deps(r, mcpOk(["a/one"])), "site-1", INPUT, "user-1");
    const logged = JSON.stringify(calls.activity[0]);
    expect(logged).toContain("site.reconnect");
    expect(logged).toContain("admin");
    expect(logged).not.toContain(INPUT.appPassword);
  });
});
