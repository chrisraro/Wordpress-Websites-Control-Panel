import { describe, expect, it, vi, beforeEach } from "vitest";

// Security finding (audit 2026-09-29, open 4): the MCP client -- which sends
// the site's WordPress application password -- connected to whatever the
// endpoint name resolved to at connect time, and to whatever pinned origin IP
// the record held, without re-checking either. It now refuses private
// targets before a transport exists, and hands the transport a guarded fetch
// so redirects are re-validated too.

const answers: Record<string, string[]> = {};
vi.mock("node:dns/promises", () => {
  const lookup = async (host: string) => {
    const a = answers[host];
    if (!a) throw new Error(`ENOTFOUND ${host}`);
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { lookup, default: { lookup } };
});

const transports: Array<{ url: URL; opts: Record<string, unknown> }> = [];
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts: Record<string, unknown>) { transports.push({ url, opts }); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    async close() {}
  },
}));

import { createSiteMcpClient } from "@/lib/mcp/client";

beforeEach(() => {
  transports.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});

const base = { username: "u", appPassword: "p" };

describe("createSiteMcpClient connect-time SSRF guard", () => {
  it("refuses an endpoint whose name now resolves privately", async () => {
    answers["rebind.test"] = ["169.254.169.254"];
    await expect(createSiteMcpClient({ ...base, endpoint: "https://rebind.test/wp-json/mcp/novamira" }))
      .rejects.toThrow(/private or local network/);
    expect(transports).toHaveLength(0);
  });

  it("checks the pinned origin IP rather than the public name", async () => {
    answers["site.test"] = ["93.184.216.34"];
    await expect(createSiteMcpClient({
      ...base, endpoint: "https://site.test/wp-json/mcp/novamira",
      originIp: "10.1.2.3", originSni: "site.test",
    })).rejects.toThrow(/private or local network/);
    expect(transports).toHaveLength(0);
  });

  it("connects to a public target through a guarded fetch", async () => {
    answers["site.test"] = ["93.184.216.34"];
    const c = await createSiteMcpClient({ ...base, endpoint: "https://site.test/wp-json/mcp/novamira" });
    expect(transports).toHaveLength(1);
    expect(typeof transports[0].opts.fetch).toBe("function");
    await c.close();
  });

  it("accepts a public origin IP even when the name is unresolvable", async () => {
    // The override exists precisely for names DNS answers badly for.
    const c = await createSiteMcpClient({
      ...base, endpoint: "https://cdn-only.test/wp-json/mcp/novamira",
      originIp: "93.184.216.34", originSni: "origin.cdn-only.test",
    });
    expect(transports).toHaveLength(1);
    await c.close();
  });
});
