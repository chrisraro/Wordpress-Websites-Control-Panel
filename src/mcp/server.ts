import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./schema";
import type { ToolCtx } from "./context";
import * as sites from "./tools/sites";
import * as inventory from "./tools/inventory";
import * as security from "./tools/security";
import * as seo from "./tools/seo";
import * as geogrid from "./tools/geogrid";
import * as reports from "./tools/reports";
import * as jobs from "./tools/jobs";
import * as manage from "./tools/manage";
import * as fleet from "./tools/fleet";
import * as gsc from "./tools/gsc";

const GROUPS: { register(server: McpServer, ctx: ToolCtx): void }[] = [
  sites, inventory, security, seo, geogrid, reports, jobs, manage, fleet, gsc,
];

/**
 * Builds a server whose tools are bound to one request's authenticated
 * context. A new instance per request is required, not merely tidy: the
 * transport runs in stateless mode because consecutive requests may land on
 * different Vercel instances, so nothing may be shared between them.
 */
export function buildServer(ctx: ToolCtx): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  for (const g of GROUPS) g.register(server, ctx);
  return server;
}
