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

/** Identifies the panel to security layers in front of WordPress.
 *  Exported so a test can pin that it is actually sent. */
export const MCP_USER_AGENT = "wp-control-panel-mcp/1.0";

export const createSiteMcpClient: McpFactory = async (opts) => {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const basic = Buffer.from(`${opts.username}:${opts.appPassword}`).toString("base64");

  const connectOnce = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(opts.endpoint), {
      requestInit: {
        headers: {
          Authorization: `Basic ${basic}`,
          // Without this the request goes out under Node's default fetch
          // agent, which security layers in front of WordPress treat as an
          // unidentified bot. Two sites in the fleet sit behind Cloudflare
          // and answered every MCP call with an interstitial challenge page
          // ("Just a moment…"), so their inventory never collected and they
          // drifted to `degraded`. Verified against both: with no
          // User-Agent the challenge fires; with this one the request
          // reaches WordPress normally.
          //
          // Deliberately an honest identifier rather than a copied browser
          // string. Impersonating Chrome would also get through, but it
          // lies about what the client is, defeats a protection the site
          // owner chose, and breaks the day the rules tighten. This name is
          // greppable in an access log and can be allowlisted precisely if
          // a site ever does need a rule. Matches the convention already
          // used by the uptime checker's `wp-control-panel-uptime/1.0`
          // (src/services/security/uptime.ts), which learned this first.
          "User-Agent": MCP_USER_AGENT,
        },
      },
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
