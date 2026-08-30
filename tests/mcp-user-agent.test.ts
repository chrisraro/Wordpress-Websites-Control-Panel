import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_USER_AGENT } from "@/lib/mcp/client";

/**
 * Two sites in the fleet sit behind Cloudflare and answered every MCP call
 * with an interstitial challenge page ("Just a moment…") because the request
 * carried no User-Agent — Node's default fetch agent reads as an
 * unidentified bot. Their inventory never collected and both drifted to
 * `degraded`. Verified live: no User-Agent → challenge; this one → the
 * request reaches WordPress.
 *
 * A source scan rather than a live call: the assertion is that the header is
 * sent at all, and the fleet is not something a test suite should reach out
 * and touch.
 */
describe("MCP client identifies itself", () => {
  const source = readFileSync(
    join(process.cwd(), "src", "lib", "mcp", "client.ts"),
    "utf8",
  );

  it("sends a User-Agent on the transport request", () => {
    expect(source).toMatch(/"User-Agent":\s*MCP_USER_AGENT/);
  });

  it("uses an honest identifier, not a browser impersonation", () => {
    // Copying a browser string would also get past the challenge, but it
    // misrepresents the client, defeats a protection the site owner chose,
    // and breaks when the rules tighten. It must stay greppable in an access
    // log so a site can allowlist it precisely.
    expect(MCP_USER_AGENT).toBe("wp-control-panel-mcp/1.0");
    expect(MCP_USER_AGENT).not.toMatch(/mozilla|chrome|safari|applewebkit|gecko/i);
  });

  it("matches the convention the uptime checker already established", () => {
    const uptime = readFileSync(
      join(process.cwd(), "src", "services", "security", "uptime.ts"),
      "utf8",
    );
    expect(uptime).toMatch(/wp-control-panel-uptime\/1\.0/);
    expect(MCP_USER_AGENT).toMatch(/^wp-control-panel-[a-z]+\/\d+\.\d+$/);
  });
});
