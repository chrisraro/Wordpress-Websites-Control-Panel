import { connectToSite } from "@/lib/mcp/connect";
import { runPhp } from "@/lib/wpphp";
import type { McpFactory, SiteMcpClient } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { AdminUsersRepo, SnapshotsRepo } from "./repo";
import type { AdminUser, InventoryPayload } from "./types";

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
  // The same file manage/service.ts writes and unlinks for the maintenance
  // action. Reading it here is what lets the panel show whether a site is
  // currently behind a maintenance page instead of offering two blind
  // buttons -- a site left in maintenance mode is invisible to the panel
  // otherwise, and its visitors see the maintenance page indefinitely.
  'maintenance' => file_exists(ABSPATH . '.maintenance'),
  'core_update' => $core,
  'plugins' => $plugins,
  'themes' => $themes,
  'admin_users' => $admins,
));
`.trim();

// WordPress admin identities travel over the wire alongside the rest of the
// inventory (the PHP snippet above still gathers $admins in the same round
// trip), but they are pulled off the raw response here and never spread into
// the InventoryPayload that gets stored in site_snapshots.payload -- see
// 0011_site_admin_users.sql and spec §5.1 for why that split exists.
type RawInventory = Omit<InventoryPayload, "collected_at"> & { admin_users: AdminUser[] };

export interface CollectedInventory { payload: InventoryPayload; adminUsers: AdminUser[] }

export async function collectInventory(client: SiteMcpClient): Promise<CollectedInventory> {
  // Throw here, before refreshSnapshot ever calls insertSnapshot, rather
  // than defaulting to []. A functioning WordPress site always has at least
  // one administrator, and PHP's json_encode(array()) serialises an empty
  // list as `[]` -- present, not absent -- so a missing admin_users key
  // means the response is malformed, never "this site has no
  // administrators". Defaulting it away would let insertSnapshot -- a plain
  // insert into insert-only history, not an upsert; it is upsertAdminUsers
  // that upserts on site_id -- stamp a fresh collected_at, report success,
  // and then show the operator "No administrator data collected yet --
  // refresh the inventory", which would be false twice over.
  const { admin_users, ...rest } = await runPhp<RawInventory>(client, INVENTORY_PHP, 120_000);
  if (!Array.isArray(admin_users)) {
    throw new Error("collectInventory: WordPress response is missing admin_users");
  }
  return { payload: { ...rest, collected_at: new Date().toISOString() }, adminUsers: admin_users };
}

export interface InventoryDeps {
  sites: SitesRepo;
  snapshots: SnapshotsRepo;
  adminUsers: AdminUsersRepo;
  mcp: McpFactory;
}

export async function refreshSnapshot(deps: InventoryDeps, siteId: string): Promise<InventoryPayload> {
  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) throw new Error(`Site not found: ${siteId}`);
  const client = await connectToSite(deps.mcp, creds);
  try {
    const { payload, adminUsers } = await collectInventory(client);
    await deps.snapshots.insertSnapshot(siteId, payload);
    await deps.adminUsers.upsertAdminUsers(siteId, adminUsers);
    return payload;
  } finally {
    await client.close();
  }
}
