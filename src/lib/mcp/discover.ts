/**
 * Finds the MCP endpoint a WordPress site actually exposes.
 *
 * The panel used to assume `/wp-json/mcp/novamira`, and adding a site whose
 * install registers a different name failed with a raw transport error:
 *
 *   {"code":"rest_no_route","message":"No route was found matching the URL
 *    and request method.","data":{"status":404}}
 *
 * That response is itself the clue. WordPress answered, in its own REST error
 * format, so the REST API is working and the site is reachable -- only the
 * namespace is missing. The route name is not fixed: one connected site here
 * registers four of them, including the plugin's unconfigured default.
 *
 *   /mcp/novamira
 *   /mcp/mcp-adapter-default-server
 *   /mcp/novamira-oauth
 *   /mcp/mcp-oauth-server
 *
 * So the name is discovered rather than assumed, and when nothing suitable
 * exists the caller can say what WAS found instead of echoing a 404.
 */

/** OAuth-only servers: this panel authenticates with application passwords. */
const OAUTH_ROUTE = /-oauth$|^mcp-oauth/i;

/** Preferred first, then anything else the plugin registered. */
const PREFERRED = ["novamira", "mcp-adapter-default-server"];

export interface McpDiscovery {
  endpoint: string;
  /** The route segment chosen, e.g. "novamira". */
  server: string;
  /** Every non-OAuth MCP server the site registered, for diagnostics. */
  candidates: string[];
}

export class McpNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpNotInstalledError";
  }
}

export function pickMcpServer(routes: string[]): { server: string | null; candidates: string[] } {
  const candidates: string[] = [];
  for (const r of routes) {
    // Exactly one segment under /mcp/. The bare "/mcp" index is not a server,
    // and another plugin's "/pixelyoursite/v1/mcp" is not ours.
    const m = /^\/mcp\/([^/]+)$/.exec(r);
    if (!m) continue;
    if (OAUTH_ROUTE.test(m[1])) continue;
    if (!candidates.includes(m[1])) candidates.push(m[1]);
  }
  for (const p of PREFERRED) {
    if (candidates.includes(p)) return { server: p, candidates };
  }
  return { server: candidates[0] ?? null, candidates };
}

const base = (url: string) => url.replace(/\/+$/, "");

/**
 * Asks the site what it exposes. Throws a message an operator can act on.
 *
 * Deliberately not silent-with-a-default: falling back to the assumed path
 * would reproduce the original 404 one step later, with the diagnosis thrown
 * away.
 */
export async function discoverMcpEndpoint(
  url: string, fetchImpl: typeof fetch = fetch,
): Promise<McpDiscovery> {
  const index = `${base(url)}/wp-json/`;
  let res: Response;
  try {
    res = await fetchImpl(index, { headers: { Accept: "application/json" }, redirect: "follow" });
  } catch (e) {
    throw new McpNotInstalledError(
      `Could not reach ${index} (${e instanceof Error ? e.message : String(e)}). ` +
      "Check the site URL, and that the site is online.",
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new McpNotInstalledError(
      `${index} answered HTTP ${res.status}. WordPress's REST API has to be reachable ` +
      "before the panel can connect. A security plugin or the host may be blocking it.",
    );
  }

  let routes: string[];
  try {
    const body = JSON.parse(text) as { routes?: Record<string, unknown> };
    routes = Object.keys(body.routes ?? {});
  } catch {
    // Plain permalinks serve HTML here, and so does a CDN interstitial.
    throw new McpNotInstalledError(
      `${index} did not return the WordPress REST index. If this site uses plain permalinks, ` +
      "switch to a pretty permalink structure in Settings > Permalinks and try again.",
    );
  }

  const { server, candidates } = pickMcpServer(routes);
  if (!server) {
    const anyMcp = routes.some((r) => r.startsWith("/mcp"));
    throw new McpNotInstalledError(
      anyMcp
        ? "This site exposes MCP but only through OAuth, which the panel does not use. " +
          "Enable the application-password MCP server on the Novamira plugin."
        : "The Novamira plugin is not active on this site, so it registers no MCP endpoint. " +
          `Install and activate it, then try again. (${routes.length} other REST routes were found, ` +
          "so WordPress itself is responding normally.)",
    );
  }
  return { endpoint: `${base(url)}/wp-json/mcp/${server}`, server, candidates };
}
