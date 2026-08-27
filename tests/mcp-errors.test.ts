import { describe, it, expect } from "vitest";
import {
  mapConnectError, McpAuthError, McpConnectionError, McpError,
} from "@/lib/mcp/errors";
import { MockMcpClient } from "@/lib/mcp/mock";

describe("mapConnectError", () => {
  it("maps HTTP 401 to McpAuthError", () => {
    expect(mapConnectError(new Error("Error POSTing to endpoint (HTTP 401): unauthorized")))
      .toBeInstanceOf(McpAuthError);
  });
  it("maps HTTP 403 to McpAuthError", () => {
    expect(mapConnectError(new Error("HTTP 403"))).toBeInstanceOf(McpAuthError);
  });
  it("maps fetch/network failures to McpConnectionError", () => {
    expect(mapConnectError(new TypeError("fetch failed"))).toBeInstanceOf(McpConnectionError);
    expect(mapConnectError(new Error("getaddrinfo ENOTFOUND site.test")))
      .toBeInstanceOf(McpConnectionError);
    expect(mapConnectError(new Error("The operation was aborted due to timeout")))
      .toBeInstanceOf(McpConnectionError);
  });
  it("wraps anything else as McpError", () => {
    const e = mapConnectError("weird");
    expect(e).toBeInstanceOf(McpError);
  });
});

describe("MockMcpClient", () => {
  it("returns configured abilities and results", async () => {
    const mock = new MockMcpClient({
      abilities: [{ name: "novamira/run-wp-cli" }],
      results: { "novamira/run-wp-cli": { stdout: "5.0.0" } },
    });
    const d = await mock.discoverAbilities();
    expect(d.abilities.map((a) => a.name)).toContain("novamira/run-wp-cli");
    expect(await mock.executeAbility("novamira/run-wp-cli", { command: "core version" }))
      .toEqual({ stdout: "5.0.0" });
    expect(mock.calls).toEqual([{ name: "novamira/run-wp-cli", args: { command: "core version" } }]);
  });

  it("throws configured failure on connect-style use", async () => {
    const mock = new MockMcpClient({ failWith: new McpAuthError("rejected") });
    await expect(mock.discoverAbilities()).rejects.toBeInstanceOf(McpAuthError);
  });
});
