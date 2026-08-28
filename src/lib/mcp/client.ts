import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mapConnectError, McpConnectionError, McpToolError } from "./errors";

export interface DiscoveredAbility { name: string; label?: string; description?: string }
export interface DiscoveredAbilities { abilities: DiscoveredAbility[]; instructions?: string }

export interface SiteMcpClient {
  listToolNames(): Promise<string[]>;
  discoverAbilities(): Promise<DiscoveredAbilities>;
  executeAbility(name: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>;
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

  const connectOnce = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(opts.endpoint), {
      requestInit: { headers: { Authorization: `Basic ${basic}` } },
    });
    const c = new Client({ name: "wp-control-panel", version: "1.0.0" }, { capabilities: {} });
    await c.connect(transport, { timeout });
    return c;
  };

  let client: Client;
  try {
    client = await connectOnce();
  } catch (e) {
    const mapped = mapConnectError(e);
    // The fleet's shared hosting drops connections transiently ("fetch failed",
    // resets). One retry after a short pause absorbs the blip; auth errors and
    // anything non-network rethrow immediately.
    if (!(mapped instanceof McpConnectionError)) throw mapped;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      client = await connectOnce();
    } catch (e2) {
      throw mapConnectError(e2);
    }
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
    async executeAbility(name, args = {}, callOpts = {}) {
      const callTimeout = callOpts.timeoutMs ?? timeout;
      try {
        const res = await client.callTool(
          { name: "mcp-adapter-execute-ability", arguments: { ability_name: name, parameters: args } },
          undefined, { timeout: callTimeout },
        );
        return parseToolResult(res);
      } catch (e) { throw mapConnectError(e); }
    },
    async close() {
      try { await client.close(); } catch { /* best effort */ }
    },
  };
};
