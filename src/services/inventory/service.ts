import { runWpCli, parseJsonArray } from "@/lib/wpcli";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { McpFactory, SiteMcpClient } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { SnapshotsRepo } from "./repo";
import type { AdminUser, InventoryPayload, PluginInfo, ThemeInfo } from "./types";

const FIELDS = "name,title,version,status,update,update_version";

export async function collectInventory(client: SiteMcpClient): Promise<InventoryPayload> {
  const wp_version = await runWpCli(client, "core version");
  const php_version = await runWpCli(client, "eval 'echo PHP_VERSION;'");
  const plugins = parseJsonArray<PluginInfo>(
    await runWpCli(client, `plugin list --format=json --fields=${FIELDS}`),
  );
  const themes = parseJsonArray<ThemeInfo>(
    await runWpCli(client, `theme list --format=json --fields=${FIELDS}`),
  );
  let core_update: string | null = null;
  try {
    const updates = parseJsonArray<{ version: string }>(
      await runWpCli(client, "core check-update --format=json"),
    );
    core_update = updates[0]?.version ?? null;
  } catch {
    core_update = null; // check-update output is advisory; never fail a snapshot on it
  }
  const admin_users = parseJsonArray<AdminUser>(
    await runWpCli(client, "user list --role=administrator --format=json --fields=ID,user_login,user_email"),
  );
  return {
    collected_at: new Date().toISOString(),
    wp_version, php_version, core_update, plugins, themes, admin_users,
  };
}

export interface InventoryDeps { sites: SitesRepo; snapshots: SnapshotsRepo; mcp: McpFactory }

export async function refreshSnapshot(deps: InventoryDeps, siteId: string): Promise<InventoryPayload> {
  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) throw new Error(`Site not found: ${siteId}`);
  const client = await deps.mcp({
    endpoint: creds.mcp_endpoint,
    username: creds.wp_username,
    appPassword: await decryptSecret(creds.app_password_encrypted),
  });
  try {
    const payload = await collectInventory(client);
    await deps.snapshots.insertSnapshot(siteId, payload);
    return payload;
  } finally {
    await client.close();
  }
}
