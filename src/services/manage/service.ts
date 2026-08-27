import { runWpCli } from "@/lib/wpcli";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";
import { enqueueJob } from "@/services/jobs/service";
import type { ManageAction } from "./types";

export const SLUG_RE = /^[a-z0-9._-]+$/i;
const ACTION_TIMEOUT_MS = 180_000;

function slug(s: string): string {
  if (!SLUG_RE.test(s)) throw new Error(`Invalid slug: ${JSON.stringify(s)}`);
  return s;
}

export function buildCommands(action: ManageAction): string[] {
  switch (action.kind) {
    case "update_core": return ["core update", "core update-db"];
    case "update_plugin": return [`plugin update ${slug(action.slug)}`];
    case "update_all_plugins": return ["plugin update --all"];
    case "update_theme": return [`theme update ${slug(action.slug)}`];
    case "activate_plugin": return [`plugin activate ${slug(action.slug)}`];
    case "deactivate_plugin": return [`plugin deactivate ${slug(action.slug)}`];
    case "maintenance": return [action.enable ? "maintenance-mode activate" : "maintenance-mode deactivate"];
    case "flush_cache": return ["cache flush"];
    case "flush_permalinks": return ["rewrite flush --hard"];
  }
}

export interface ManageDeps { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }

export async function manageSite(
  deps: ManageDeps, siteId: string, actorId: string, action: ManageAction,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  let commands: string[];
  try {
    commands = buildCommands(action);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) return { ok: false, error: "Site not found" };

  let output = "";
  let error: string | undefined;
  try {
    const client = await deps.mcp({
      endpoint: creds.mcp_endpoint,
      username: creds.wp_username,
      appPassword: await decryptSecret(creds.app_password_encrypted),
    });
    try {
      for (const cmd of commands) {
        output = await runWpCli(client, cmd, ACTION_TIMEOUT_MS);
      }
    } finally {
      await client.close();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: `site.manage.${action.kind}`,
    detail: { action, ok: !error, ...(error ? { error } : {}) },
  });
  if (!error) {
    await enqueueJob(deps.jobs, "snapshot_refresh", siteId, {}, { dedupe: true });
    return { ok: true, output };
  }
  return { ok: false, error };
}
