import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mapConnectError, McpToolError } from "./errors";

export interface DiscoveredAbility { name: string; label?: string; description?: string }
export interface DiscoveredAbilities { abilities: DiscoveredAbility[]; instructions?: string }

export interface SiteMcpClient {
  listToolNames(): Promise<string[]>;
  discoverAbilities(): Promise<DiscoveredAbilities>;
  executeAbility(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpConnectOptions {
  endpoint: string;
  username: string;
  appPassword: string;
  timeoutMs?: number;
}

export type McpFactory = (opts: McpConnectOptions) => Promise<SiteMcpClient>;

const DEFAULT_TIMEOUT = 30_000;

/** Extract the JSON payload from an MCP tool result's content blocks. */
function parseToolResult(result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
} & Record<string, unknown>): unknown {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  if (result.isError) throw new McpToolError(text || "MCP tool returned an error");
  try { return JSON.parse(text); } catch { return text; }
}

export const createSiteMcpClient: McpFactory = async (opts) => {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const basic = Buffer.from(`${opts.username}:${opts.appPassword}`).toString("base64");
  const transport = new StreamableHTTPClientTransport(new URL(opts.endpoint), {
    requestInit: { headers: { Authorization: `Basic ${basic}` } },
  });
  const client = new Client({ name: "wp-control-panel", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (e) {
    throw mapConnectError(e);
  }

  return {
    async listToolNames() {
      try {
        const { tools } = await client.listTools(undefined, { timeout });
        return tools.map((t) => t.name);
      } catch (e) { throw mapConnectError(e); }
    },
    async discoverAbilities() {
      try {
        const res = await client.callTool(
          { name: "mcp-adapter-discover-abilities", arguments: {} }, undefined, { timeout },
        );
        const parsed = parseToolResult(res) as {
          abilities?: DiscoveredAbility[]; novamira_instructions?: string;
        };
        return { abilities: parsed.abilities ?? [], instructions: parsed.novamira_instructions };
      } catch (e) { throw mapConnectError(e); }
    },
    async executeAbility(name, args = {}) {
      try {
        const res = await client.callTool(
          { name: "mcp-adapter-execute-ability", arguments: { ability_name: name, parameters: args } },
          undefined, { timeout },
        );
        return parseToolResult(res);
      } catch (e) { throw mapConnectError(e); }
    },
    async close() {
      try { await client.close(); } catch { /* best effort */ }
    },
  };
};
