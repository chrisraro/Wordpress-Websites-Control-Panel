import { connectToSite } from "@/lib/mcp/connect";
import { runPhp } from "@/lib/wpphp";
import { installPlugin, type InstallDeps } from "@/services/marketplace/install";

/**
 * "Set up backups" for one site: UpdraftPlus installed and active, Google
 * Drive among its destinations, and a backup schedule actually registered.
 *
 * Idempotent and conservative. It adds Google Drive but never removes a
 * destination the site already uses; it sets a weekly schedule only where
 * backups are manual or unset, and leaves an existing cadence alone. It then
 * re-registers the schedule with WP-Cron, because a configured-but-missing
 * cron event (found live on graceland.ph) means no backup ever runs.
 *
 * What it cannot do is authorize Google Drive: that is a Google consent
 * screen someone must click through once per site, signed in as the
 * agency's Drive account. The result says whether that is still needed; the
 * Drive token itself is never read out, logged or returned.
 */

export const SETUP_UPDRAFT_PHP = `
if (!function_exists('get_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
$file = 'updraftplus/updraftplus.php';
$all = get_plugins();
if (!isset($all[$file])) { return json_encode(array('state' => 'not_installed')); }
$activated = false;
if (!is_plugin_active($file)) {
  $r = activate_plugin($file);
  if (is_wp_error($r)) { return json_encode(array('state' => 'error', 'error' => $r->get_error_message())); }
  $activated = true;
}
$changed = array();
$svc = get_option('updraft_service');
$list = is_array($svc) ? $svc : (is_string($svc) && $svc !== '' ? array($svc) : array());
$list = array_values(array_filter($list, function ($s) { return is_string($s) && $s !== '' && $s !== 'none'; }));
if (!in_array('googledrive', $list, true)) {
  $list[] = 'googledrive';
  update_option('updraft_service', $list);
  $changed[] = 'Google Drive added as a backup destination';
}
$gd = get_option('updraft_googledrive');
if (!is_array($gd) || empty($gd['settings'])) {
  $id = 's-' . md5(uniqid('', true));
  update_option('updraft_googledrive', array('version' => '1', 'settings' => array($id => array('folder' => 'UpdraftPlus', 'instance_enabled' => 1))));
  $changed[] = 'Google Drive destination created';
}
foreach (array('updraft_interval' => 'Files', 'updraft_interval_database' => 'Database') as $opt => $label) {
  $v = get_option($opt);
  if (!$v || $v === 'manual') { update_option($opt, 'weekly'); $changed[] = $label . ' backups set to weekly'; }
}
$fi = get_option('updraft_interval');
$di = get_option('updraft_interval_database');
global $updraftplus;
if (is_object($updraftplus) && method_exists($updraftplus, 'schedule_backup')) {
  $updraftplus->schedule_backup($fi);
  $updraftplus->schedule_backup_database($di);
} else {
  if (!wp_next_scheduled('updraft_backup')) { wp_schedule_event(time() + 600, $fi, 'updraft_backup'); }
  if (!wp_next_scheduled('updraft_backup_database')) { wp_schedule_event(time() + 600, $di, 'updraft_backup_database'); }
}
$authorized = false;
$gd = get_option('updraft_googledrive');
if (is_array($gd) && !empty($gd['settings'])) {
  foreach ($gd['settings'] as $c) { if (is_array($c) && !empty($c['token'])) { $authorized = true; } }
}
$next = wp_next_scheduled('updraft_backup');
return json_encode(array(
  'state' => 'configured', 'activated' => $activated, 'changed' => $changed,
  'drive_authorized' => $authorized, 'next_backup' => $next ? $next : null,
));
`.trim();

type SetupPhpResult =
  | { state: "not_installed" }
  | { state: "error"; error: string }
  | { state: "configured"; activated: boolean; changed: string[]; drive_authorized: boolean; next_backup: number | null };

export interface BackupSetupResult {
  /** UpdraftPlus was installed by this run. */
  installed: boolean;
  activated: boolean;
  changed: string[];
  /** false = someone still has to "Sign in with Google" in the site's UpdraftPlus settings. */
  driveAuthorized: boolean;
  nextBackup: number | null;
}

async function configure(deps: InstallDeps, siteId: string): Promise<SetupPhpResult> {
  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) throw new Error("Site not found");
  const client = await connectToSite(deps.mcp, creds);
  try {
    return await runPhp<SetupPhpResult>(client, SETUP_UPDRAFT_PHP, 60_000);
  } finally {
    await client.close();
  }
}

export async function setupUpdraft(
  deps: InstallDeps, siteId: string, actorId: string,
): Promise<BackupSetupResult> {
  let installed = false;
  let res = await configure(deps, siteId);
  if (res.state === "not_installed") {
    const install = await installPlugin(deps, siteId, actorId, { kind: "wporg", slug: "updraftplus" }, true);
    if (!install.ok) throw new Error(`Could not install UpdraftPlus: ${install.error ?? "install failed"}`);
    installed = true;
    res = await configure(deps, siteId);
  }
  if (res.state !== "configured") {
    throw new Error(res.state === "error" ? `Could not activate UpdraftPlus: ${res.error}` : "UpdraftPlus is still not installed");
  }
  const result: BackupSetupResult = {
    installed,
    activated: res.activated,
    changed: res.changed,
    driveAuthorized: res.drive_authorized,
    nextBackup: res.next_backup,
  };
  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: "site.backup_setup",
    detail: { ...result },
  });
  return result;
}
