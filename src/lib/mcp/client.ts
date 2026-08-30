import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent } from "undici";
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
  /**
   * Optional direct-to-origin connection, for a site whose CDN challenges
   * requests from this app's egress (see 0019_site_origin_override.sql).
   * Both or neither -- a half-configured override is refused rather than
   * guessed at.
   */
  originIp?: string | null;
  originSni?: string | null;
}

export type McpFactory = (opts: McpConnectOptions) => Promise<SiteMcpClient>;

const DEFAULT_TIMEOUT = 30_000;

/**
 * Builds a dispatcher that connects to `ip` while verifying the certificate
 * against `sni`, leaving the Host header as whatever the URL says.
 *
 * That three-way split is the whole trick, and each part is load-bearing:
 *
 *   - `lookup` pins the TCP connection to the origin, so DNS -- which
 *     currently answers with the CDN's address -- is bypassed.
 *   - `servername` sets SNI, and Node's default checkServerIdentity verifies
 *     the presented certificate against it. The site's own hostname cannot
 *     be used here because the origin's certificate for that name has
 *     expired behind the CDN.
 *   - The Host header still carries the real hostname (the URL is
 *     unchanged), which is what selects the right vhost on shared hosting.
 *
 * Verification stays ON. `rejectUnauthorized` is never touched: a WordPress
 * application password travels over this connection, and trading a bot
 * challenge for a credential-interception risk would be a bad deal at any
 * price. What the operator asserts by configuring this is "that IP, holding
 * a certificate for that name, is my host" -- a narrower claim than "trust
 * anything that answers", and one they are in a position to make.
 */
function originDispatcher(ip: string, sni: string): Agent {
  return new Agent({
    connect: {
      servername: sni,
      // Both callback shapes. Node calls `lookup` with `all: true` when
      // autoSelectFamily is on (the default since Node 20) and expects an
      // array; without it, it expects `(err, address, family)`. Getting this
      // wrong throws inside connect and surfaces as a generic "fetch
      // failed", which is indistinguishable from the origin refusing the
      // connection -- so supporting both removes a variable that would
      // otherwise be impossible to tell apart from a network block.
      lookup: (_hostname, options, callback) => {
        const family = ip.includes(":") ? 6 : 4;
        if (options && (options as { all?: boolean }).all) {
          (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(
            null, [{ address: ip, family }],
          );
        } else {
          (callback as (e: null, a: string, f: number) => void)(null, ip, family);
        }
      },
    },
  });
}

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

  // Both or neither. Half a configuration produces a connection that fails
  // in a way nobody can read, so refuse it where the mistake was made.
  const hasIp = Boolean(opts.originIp);
  const hasSni = Boolean(opts.originSni);
  if (hasIp !== hasSni) {
    throw new McpConnectionError(
      "This site has a partial direct-origin configuration: set both the origin IP and the certificate name, or neither.",
    );
  }
  const dispatcher =
    hasIp && hasSni ? originDispatcher(opts.originIp!, opts.originSni!) : undefined;

  const connectOnce = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(opts.endpoint), {
      requestInit: {
        // `dispatcher` is Node's undici extension to RequestInit; it is
        // absent from the DOM RequestInit type, hence the cast.
        ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
        headers: {
          Authorization: `Basic ${basic}`,
          // Identifies the panel to whatever sits in front of WordPress.
          // Without it the request goes out under Node's default fetch agent
          // and is indistinguishable from any other unattributed client.
          //
          // This does NOT by itself get past a bot challenge, and an earlier
          // version of this comment wrongly claimed it did. Two sites in the
          // fleet (both Azalea domains) sit behind Cloudflare and answer
          // every MCP call from production with an interstitial page ("Just
          // a moment…"). Measured: from a residential IP, Node fetch reaches
          // WordPress with or without this header; from Vercel it is
          // challenged either way. The discriminator is the source IP and
          // TLS fingerprint of a datacenter egress, which no header changes.
          // Those sites need a Cloudflare WAF skip rule — see
          // docs/ops/cloudflare.md — and this header is what such a rule can
          // key on, which is the reason to send it.
          //
          // Deliberately an honest identifier rather than a copied browser
          // string. Impersonating Chrome might defeat the challenge, but it
          // misrepresents the client, defeats a protection the site owner
          // chose, and breaks the day the rules tighten. This name is
          // greppable in an access log. Matches the convention already used
          // by the uptime checker's `wp-control-panel-uptime/1.0`
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
      // The Agent owns a connection pool. Without this every call that used
      // an origin override leaks its sockets, which on a serverless function
      // means they accumulate for the life of the instance -- and this path
      // is used by the nightly fan-out across every configured site.
      try { await dispatcher?.close(); } catch { /* best effort */ }
    },
  };
};
