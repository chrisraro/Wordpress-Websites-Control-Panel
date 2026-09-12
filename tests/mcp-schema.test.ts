import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "@/mcp/schema";

describe("the SDK accepts this project's zod and round-trips a tool", () => {
  it("lists a tool with a usable input schema and calls it", async () => {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

    server.registerTool(
      "echo_site",
      {
        description:
          "Test tool. Sites carry an environment; never confuse staging with production.",
        inputSchema: {
          site_id: z.string().uuid().describe("The site's id"),
          times: z.number().int().min(1).max(3).default(1),
        },
      },
      async ({ site_id, times }) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ site_id, times }) }],
      }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const tool = listed.tools.find((t) => t.name === "echo_site");
    expect(tool).toBeDefined();
    // The schema must survive conversion with its properties intact -- an empty
    // or absent properties object is the exact failure mode of a zod/SDK
    // version mismatch, and it fails silently at runtime rather than at build.
    expect(tool!.inputSchema.type).toBe("object");
    expect(Object.keys((tool!.inputSchema as { properties: object }).properties))
      .toEqual(expect.arrayContaining(["site_id", "times"]));

    const result = await client.callTool({
      name: "echo_site",
      arguments: { site_id: "11111111-1111-1111-1111-111111111111", times: 2 },
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toEqual({
      site_id: "11111111-1111-1111-1111-111111111111",
      times: 2,
    });

    await client.close();
    await server.close();
  });

  it("rejects arguments that violate the schema", async () => {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    server.registerTool(
      "needs_uuid",
      { description: "Test tool.", inputSchema: { site_id: z.string().uuid() } },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "needs_uuid",
      arguments: { site_id: "not-a-uuid" },
    });
    expect(result.isError).toBe(true);

    await client.close();
    await server.close();
  });

  it("exposes a non-placeholder server version", () => {
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
