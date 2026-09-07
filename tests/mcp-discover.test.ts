import { describe, it, expect } from "vitest";
import { pickMcpServer, discoverMcpEndpoint, McpNotInstalledError } from "@/lib/mcp/discover";
import { friendlySiteError } from "@/lib/mcp/errors";

/**
 * Adding a site failed with a raw transport error:
 *   {"code":"rest_no_route", ... "status":404}
 * because the panel assumed every install exposes /wp-json/mcp/novamira.
 * One connected site here registers four different MCP routes, including the
 * plugin's unconfigured default, so the name is discovered, not assumed.
 */

// Exactly what onlinecreativesolutions.com returns today.
const REAL_ROUTES = [
  "/", "/wp/v2/posts", "/mcp", "/mcp/novamira", "/mcp/mcp-adapter-default-server",
  "/mcp/novamira-oauth", "/pixelyoursite/v1/mcp", "/mcp/mcp-oauth-server",
];

const index = (routes: string[], status = 200) =>
  (async () => new Response(JSON.stringify({ routes: Object.fromEntries(routes.map(r => [r, {}])) }),
    { status })) as unknown as typeof fetch;

describe("pickMcpServer", () => {
  it("prefers novamira when the site offers several", () => {
    const { server } = pickMcpServer(REAL_ROUTES);
    expect(server).toBe("novamira");
  });

  it("falls back to the plugin's default name, which is what a fresh install has", () => {
    // The actual reported failure: a new site with only the default server.
    const { server } = pickMcpServer(["/mcp", "/mcp/mcp-adapter-default-server"]);
    expect(server).toBe("mcp-adapter-default-server");
  });

  it("takes an unrecognised name rather than giving up", () => {
    expect(pickMcpServer(["/mcp/acme-server"]).server).toBe("acme-server");
  });

  it("never picks an OAuth server, which cannot take an application password", () => {
    const { server, candidates } = pickMcpServer(["/mcp/novamira-oauth", "/mcp/mcp-oauth-server"]);
    expect(server).toBeNull();
    expect(candidates).toEqual([]);
  });

  it("ignores the bare index and another plugin's MCP route", () => {
    // "/mcp" is a listing, and "/pixelyoursite/v1/mcp" belongs to a different
    // plugin entirely -- connecting to either would fail confusingly.
    const { candidates } = pickMcpServer(REAL_ROUTES);
    expect(candidates).not.toContain("");
    expect(candidates.join()).not.toContain("pixelyoursite");
  });
});

describe("discoverMcpEndpoint", () => {
  it("builds the endpoint from what the site actually registered", async () => {
    const d = await discoverMcpEndpoint("https://example.com/", index(REAL_ROUTES));
    expect(d.endpoint).toBe("https://example.com/wp-json/mcp/novamira");
  });

  it("handles a subdirectory install without doubling slashes", async () => {
    const d = await discoverMcpEndpoint("https://x.com/staging2/", index(["/mcp/novamira"]));
    expect(d.endpoint).toBe("https://x.com/staging2/wp-json/mcp/novamira");
  });

  it("says the plugin is missing, and that WordPress itself is fine", async () => {
    // The distinction that matters: a reachable site missing one plugin is a
    // different job from an unreachable site.
    await expect(discoverMcpEndpoint("https://example.com", index(["/", "/wp/v2/posts"])))
      .rejects.toThrow(/Novamira plugin is not active/i);
  });

  it("explains an OAuth-only install rather than reporting nothing found", async () => {
    await expect(discoverMcpEndpoint("https://example.com", index(["/mcp/novamira-oauth"])))
      .rejects.toThrow(/only through OAuth/i);
  });

  it("names plain permalinks when the index is not JSON", async () => {
    // The other common cause of a 404 here, and it is fixed in Settings.
    const f = (async () => new Response("<html>home page</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(discoverMcpEndpoint("https://example.com", f)).rejects.toThrow(/permalink/i);
  });

  it("reports an HTTP error on the index as a blocked REST API", async () => {
    const f = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(discoverMcpEndpoint("https://example.com", f)).rejects.toThrow(/REST API has to be reachable/i);
  });

  it("reports an unreachable host as such", async () => {
    const f = (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    const err = await discoverMcpEndpoint("https://nope.example", f).catch((e) => e);
    expect(err).toBeInstanceOf(McpNotInstalledError);
    expect(String(err)).toMatch(/ENOTFOUND/);
  });
});

describe("friendlySiteError", () => {
  it("translates rest_no_route instead of echoing WordPress's JSON", () => {
    const raw = 'Streamable HTTP error: Error POSTing to endpoint: {"code":"rest_no_route",' +
      '"message":"No route was found matching the URL and request method.","data":{"status":404}}';
    const out = friendlySiteError(new Error(raw));
    expect(out).toMatch(/Novamira plugin is not active|different name/i);
    expect(out).not.toContain("rest_no_route");
    expect(out).not.toContain("{");
  });
});
