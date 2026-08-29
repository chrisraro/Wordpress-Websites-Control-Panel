import { runPhp } from "@/lib/wpphp";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { McpFactory, SiteMcpClient } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { SnapshotsRepo } from "./repo";
import type { InventoryPayload } from "./types";

// One round trip collects the whole inventory inside WordPress. WP-CLI is not
// used at all: many shared hosts (including this project's) expose a broken
// cgi-fcgi PHP SAPI to the wp binary, while in-process PHP always works.
export const INVENTORY_PHP = `
if (!function_exists('get_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
if (!function_exists('wp_update_plugins')) { require_once ABSPATH . 'wp-includes/update.php'; }
wp_update_plugins(); wp_update_themes(); wp_version_check();
$pu = get_site_transient('update_plugins');
$tu = get_site_transient('update_themes');
$cu = get_site_transient('update_core');
$active = (array) get_option('active_plugins', array());
$network = function_exists('get_site_option') ? array_keys((array) get_site_option('active_sitewide_plugins', array())) : array();
$plugins = array();
foreach (get_plugins() as $file => $p) {
  $upd = (is_object($pu) && isset($pu->response[$file])) ? $pu->response[$file] : null;
  $plugins[] = array(
    'file' => $file,
    'name' => dirname($file) !== '.' ? dirname($file) : basename($file, '.php'),
    'title' => $p['Name'],
    'version' => $p['Version'],
    'status' => (in_array($file, $active, true) || in_array($file, $network, true)) ? 'active' : 'inactive',
    'update' => $upd ? 'available' : 'none',
    'update_version' => $upd ? (is_array($upd) ? ($upd['new_version'] ?? null) : ($upd->new_version ?? null)) : null,
  );
}
$current = get_stylesheet();
$themes = array();
foreach (wp_get_themes() as $stylesheet => $t) {
  $upd = (is_object($tu) && isset($tu->response[$stylesheet])) ? $tu->response[$stylesheet] : null;
  $themes[] = array(
    'name' => $stylesheet,
    'template' => $t->get_template(),
    'title' => $t->get('Name'),
    'version' => $t->get('Version'),
    'status' => $stylesheet === $current ? 'active' : 'inactive',
    'update' => $upd ? 'available' : 'none',
    'update_version' => $upd ? (is_array($upd) ? ($upd['new_version'] ?? null) : ($upd->new_version ?? null)) : null,
  );
}
$core = null;
if (is_object($cu) && !empty($cu->updates)) {
  foreach ($cu->updates as $u) { if (isset($u->response) && $u->response === 'upgrade') { $core = $u->version; break; } }
}
$admins = array();
foreach (get_users(array('role' => 'administrator', 'fields' => array('ID', 'user_login', 'user_email'))) as $u) {
  $admins[] = array('ID' => (int) $u->ID, 'user_login' => $u->user_login, 'user_email' => $u->user_email);
}
return json_encode(array(
  'wp_version' => get_bloginfo('version'),
  'php_version' => PHP_VERSION,
  'admin_url' => admin_url(),
  'core_update' => $core,
  'plugins' => $plugins,
  'themes' => $themes,
  'admin_users' => $admins,
));
`.trim();

type RawInventory = Omit<InventoryPayload, "collected_at">;

export async function collectInventory(client: SiteMcpClient): Promise<InventoryPayload> {
  const raw = await runPhp<RawInventory>(client, INVENTORY_PHP, 120_000);
  return { ...raw, collected_at: new Date().toISOString() };
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
