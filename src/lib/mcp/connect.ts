import { decryptSecret } from "@/lib/crypto/secrets";
import type { McpFactory, SiteMcpClient } from "./client";
import type { SiteCredentials } from "@/services/sites/types";

/**
 * Opens an MCP connection from a site's stored credentials.
 *
 * Exists so the direct-to-origin override cannot be forgotten. Nine services
 * open connections, each previously spelling out endpoint/username/password
 * by hand; adding a field to that shape meant editing nine call sites, and
 * one that quietly omitted `originIp` would have failed only for the sites
 * that need it -- which are exactly the ones no test exercises and no
 * developer visits by default. One door instead.
 */
export async function connectToSite(
  mcp: McpFactory,
  creds: SiteCredentials,
  opts?: { timeoutMs?: number },
): Promise<SiteMcpClient> {
  return mcp({
    endpoint: creds.mcp_endpoint,
    username: creds.wp_username,
    appPassword: await decryptSecret(creds.app_password_encrypted),
    originIp: creds.origin_ip ?? null,
    originSni: creds.origin_sni ?? null,
    ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
