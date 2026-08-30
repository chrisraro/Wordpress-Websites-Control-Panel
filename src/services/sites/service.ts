import { connectToSite } from "@/lib/mcp/connect";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";
import { McpAuthError, McpConnectionError } from "@/lib/mcp/errors";
import type { McpFactory } from "@/lib/mcp/client";
import { visibleSiteIds, type Viewer } from "@/lib/authz/decide";
import { enqueueJob } from "@/services/jobs/service";
import type { JobsRepo } from "@/services/jobs/repo";
import type { SitesRepo } from "./repo";
import type { NewSiteInput, SiteRow, SiteStatus } from "./types";

export interface SitesDeps {
  repo: SitesRepo;
  mcp: McpFactory;
  // Required, not optional: a newly connected site needs its first
  // snapshot_refresh enqueued (see addSite below), and an optional field is
  // exactly the kind of thing a caller silently omits. There are two paths
  // that create sites today (the /sites/new server action and
  // scripts/import-novamira-sites.ts) and every other caller of this file's
  // functions has to construct a SitesDeps regardless, so making this
  // required just means every call site is honest about the dependency.
  jobs: JobsRepo;
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
    // Recorded, never inferred. This is the one moment the operator knows the
    // answer for certain, which is why the form asks rather than leaving
    // isStaging()'s regex as the permanent source of truth (see 0017).
    environment: input.environment,
    capabilities: { abilities },
    created_by: actorId,
  });
  await deps.repo.insertActivity({
    actor: actorId, site_id: id, action: "site.connect",
    detail: { url: input.url, abilities: abilities.length },
  });

  // Without this, a newly connected site shows no inventory until the
  // nightly 02:00 UTC fan-out (src/app/api/cron/enqueue/route.ts) reaches it
  // — up to a day blank on the dashboard. Enqueue only: collecting inventory
  // means an MCP round trip plus PHP execution on the live site, which
  // belongs on the queue (drained within a minute by the per-minute cron),
  // not inline in this request, which would risk the connect form hanging
  // or hitting the serverless timeout.
  //
  // The site is already created and connected at this point, which is a
  // genuinely usable state — throwing here would make the caller believe
  // the connect itself failed, when only the inventory kick-off did. So a
  // failed enqueue must not undo or fail the connect. It is not swallowed
  // silently, though: it's logged so the gap is visible to an operator, and
  // the site is still picked up by tomorrow's nightly fan-out regardless.
  try {
    await enqueueJob(deps.jobs, "snapshot_refresh", id, {}, { dedupe: true });
  } catch (e) {
    console.error(`[sites] failed to enqueue initial snapshot_refresh for site ${id}:`, e);
  }

  return { id };
}

export async function listSites(deps: SitesDeps): Promise<SiteRow[]> {
  return deps.repo.listSites();
}

/** Sites this viewer may see: all of them, or exactly their grants. */
export async function listSitesForViewer(
  deps: SitesDeps, viewer: Viewer,
): Promise<SiteRow[]> {
  const all = await deps.repo.listSites();
  const visible = visibleSiteIds(viewer, all.map((s) => s.id));
  return visible === "all" ? all : all.filter((s) => visible.includes(s.id));
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
    const client = await connectToSite(deps.mcp, creds);
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
