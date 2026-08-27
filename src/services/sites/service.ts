import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";
import { McpAuthError, McpConnectionError } from "@/lib/mcp/errors";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "./repo";
import type { NewSiteInput, SiteRow, SiteStatus } from "./types";

export interface SitesDeps {
  repo: SitesRepo;
  mcp: McpFactory;
}

export function mcpEndpointFor(url: string): string {
  return `${url.replace(/\/+$/, "")}/wp-json/mcp/novamira`;
}

export async function addSite(
  deps: SitesDeps, input: NewSiteInput, actorId: string,
): Promise<{ id: string }> {
  const endpoint = mcpEndpointFor(input.url);
  let abilities: string[];
  const client = await connectOrExplain(deps.mcp, endpoint, input.wpUsername, input.appPassword);
  try {
    const discovered = await client.discoverAbilities();
    abilities = discovered.abilities.map((a) => a.name);
  } catch (e) {
    throw explain(e);
  } finally {
    await client.close();
  }

  const { id } = await deps.repo.insertSite({
    name: input.name,
    url: input.url.replace(/\/+$/, ""),
    mcp_endpoint: endpoint,
    wp_username: input.wpUsername,
    app_password_encrypted: await encryptSecret(input.appPassword),
    client_label: input.clientLabel ?? null,
    capabilities: { abilities },
    created_by: actorId,
  });
  await deps.repo.insertActivity({
    actor: actorId, site_id: id, action: "site.connect",
    detail: { url: input.url, abilities: abilities.length },
  });
  return { id };
}

export async function listSites(deps: SitesDeps): Promise<SiteRow[]> {
  return deps.repo.listSites();
}

export async function getSite(deps: SitesDeps, id: string): Promise<SiteRow | null> {
  return deps.repo.getSite(id);
}

export async function testSiteConnection(
  deps: SitesDeps, id: string, actorId: string,
): Promise<{ ok: boolean; status: SiteStatus; error?: string }> {
  const creds = await deps.repo.getSiteCredentials(id);
  if (!creds) return { ok: false, status: "disabled", error: "Site not found" };

  let status: SiteStatus = "connected";
  let errorMsg: string | undefined;
  try {
    const client = await deps.mcp({
      endpoint: creds.mcp_endpoint,
      username: creds.wp_username,
      appPassword: await decryptSecret(creds.app_password_encrypted),
    });
    try {
      await client.discoverAbilities();
    } finally {
      await client.close();
    }
  } catch (e) {
    if (e instanceof McpAuthError) {
      status = "reconnect_needed";
      errorMsg = "Application password was rejected — reconnect the site.";
    } else if (e instanceof McpConnectionError) {
      status = "degraded";
      errorMsg = "Site is unreachable.";
    } else {
      status = "degraded";
      errorMsg = e instanceof Error ? e.message : String(e);
    }
  }

  await deps.repo.updateSiteStatus(id, status);
  await deps.repo.insertActivity({
    actor: actorId, site_id: id, action: "site.test_connection",
    detail: { ok: !errorMsg, status, error: errorMsg },
  });
  return { ok: !errorMsg, status, error: errorMsg };
}

function explain(e: unknown): Error {
  if (e instanceof McpAuthError) {
    return new Error("WordPress rejected the application password. Check the username and app password.");
  }
  if (e instanceof McpConnectionError) {
    return new Error("Could not reach the site's MCP endpoint. Is Novamira active and the URL correct?");
  }
  return e instanceof Error ? e : new Error(String(e));
}

async function connectOrExplain(
  mcp: McpFactory, endpoint: string, username: string, appPassword: string,
) {
  try {
    return await mcp({ endpoint, username, appPassword });
  } catch (e) {
    throw explain(e);
  }
}
