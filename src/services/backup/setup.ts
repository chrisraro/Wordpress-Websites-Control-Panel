import { z } from "zod";
import { connectToSite } from "@/lib/mcp/connect";
import { runPhp } from "@/lib/wpphp";
import { installPlugin, type InstallDeps } from "@/services/marketplace/install";

/**
 * "Set up backups" for one site: UpdraftPlus installed and active, Google
 * Drive among its destinations, and a backup schedule actually registered.
 *
 * Idempotent and conservative. It adds Google Drive but never removes a
 * destination the site already uses, and never replaces existing Drive
 * settings; it sets a weekly schedule only where none is set, and leaves an
 * existing cadence (including a deliberate "manual") alone. It then
 * re-registers the schedule with WP-Cron, because a configured-but-missing
 * cron event (found live on graceland.ph) means no backup ever runs.
 *
 * What it cannot do is authorize Google Drive: that is a Google consent
 * screen someone must click through once per site, signed in as the
 * agency's Drive account. The result says whether that is still needed; the
 * Drive token itself is never read out, logged or returned.
 */

/**
 * Activation runs in a request of its own: a fatal in the plugin file kills
 * the PHP request it happens in, and that must not be the one that also
 * reads and writes UpdraftPlus's settings.
 */
export const ACTIVATE_UPDRAFT_PHP = `
if (!function_exists('activate_plugin')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
$r = activate_plugin('updraftplus/updraftplus.php');
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
return json_encode(array('ok' => is_plugin_active('updraftplus/updraftplus.php')));
`.trim();

export const SETUP_UPDRAFT_PHP = `
if (!function_exists('get_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
$file = 'updraftplus/updraftplus.php';
$all = get_plugins();
if (!isset($all[$file])) { return json_encode(array('state' => 'not_installed')); }
if (!is_plugin_active($file)) { return json_encode(array('state' => 'inactive')); }
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
$legacy = false;
if ($gd === false || $gd === '' || $gd === array()) {
  $id = 's-' . md5(uniqid('', true));
  add_option('updraft_googledrive', array('version' => '1', 'settings' => array($id => array('folder' => 'UpdraftPlus', 'instance_enabled' => 1))));
  $changed[] = 'Google Drive destination created';
} elseif (!is_array($gd) || !isset($gd['settings'])) {
  // An older flat format (may hold live credentials): never replaced.
  $legacy = true;
}
foreach (array('updraft_interval' => 'Files', 'updraft_interval_database' => 'Database') as $opt => $label) {
  $v = get_option($opt);
  if ($v === false || $v === '') { update_option($opt, 'weekly'); $changed[] = $label . ' backups set to weekly'; }
}
$fi = get_option('updraft_interval');
$di = get_option('updraft_interval_database');
wp_clear_scheduled_hook('updraft_backup');
wp_clear_scheduled_hook('updraft_backup_database');
global $updraftplus;
if (is_object($updraftplus) && method_exists($updraftplus, 'schedule_backup')) {
  $updraftplus->schedule_backup($fi);
  $updraftplus->schedule_backup_database($di);
} else {
  if ($fi !== 'manual') { wp_schedule_event(time() + 600, $fi, 'updraft_backup'); }
  if ($di !== 'manual') { wp_schedule_event(time() + 600, $di, 'updraft_backup_database'); }
}
$authorized = false;
$gd = get_option('updraft_googledrive');
if (is_array($gd) && isset($gd['settings']) && is_array($gd['settings'])) {
  foreach ($gd['settings'] as $c) { if (is_array($c) && !empty($c['token'])) { $authorized = true; } }
} elseif (is_array($gd) && !empty($gd['token'])) {
  $authorized = true;
}
$next = wp_next_scheduled('updraft_backup');
return json_encode(array(
  'state' => 'configured', 'changed' => $changed, 'legacy_drive_format' => $legacy,
  'drive_authorized' => $authorized, 'next_backup' => $next ? $next : null,
));
`.trim();

/** What the site says, validated: a hostile or broken site's JSON is never trusted as-is. */
const SetupResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_installed") }),
  z.object({ state: z.literal("inactive") }),
  z.object({
    state: z.literal("configured"),
    changed: z.array(z.string()),
    legacy_drive_format: z.boolean().optional(),
    drive_authorized: z.boolean(),
    next_backup: z.number().int().nullable(),
  }),
]);
type SetupPhpResult = z.infer<typeof SetupResultSchema>;

const MAX_CHANGED = 10;
const MAX_CHANGE_LEN = 120;

export interface BackupSetupResult {
  /** UpdraftPlus was installed by this run. */
  installed: boolean;
  /** UpdraftPlus was activated by this run. */
  activated: boolean;
  changed: string[];
  /** false = someone still has to "Sign in with Google" in the site's UpdraftPlus settings. */
  driveAuthorized: boolean;
  /** Drive settings are in an older format the panel will not touch; check by hand. */
  legacyDriveFormat: boolean;
  nextBackup: number | null;
}

async function onSite<T>(deps: InstallDeps, siteId: string, code: string): Promise<T> {
  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) throw new Error("Site not found");
  const client = await connectToSite(deps.mcp, creds);
  try {
    return await runPhp<T>(client, code, 60_000);
  } finally {
    await client.close();
  }
}

async function configure(deps: InstallDeps, siteId: string): Promise<SetupPhpResult> {
  const parsed = SetupResultSchema.safeParse(await onSite<unknown>(deps, siteId, SETUP_UPDRAFT_PHP));
  if (!parsed.success) throw new Error("UpdraftPlus setup returned an unexpected result");
  return parsed.data;
}

export async function setupUpdraft(
  deps: InstallDeps, siteId: string, actorId: string,
): Promise<BackupSetupResult> {
  let installed = false;
  let activated = false;
  let res = await configure(deps, siteId);
  if (res.state === "not_installed") {
    const install = await installPlugin(deps, siteId, actorId, { kind: "wporg", slug: "updraftplus" }, true);
    // installPlugin already records the site's own error in the activity log.
    if (!install.ok) throw new Error("Could not install UpdraftPlus from wordpress.org (details in the activity log)");
    installed = true;
    res = await configure(deps, siteId);
  }
  if (res.state === "inactive") {
    const act = await onSite<{ ok?: unknown }>(deps, siteId, ACTIVATE_UPDRAFT_PHP);
    // The site's WP_Error text can carry filesystem paths: never in the message.
    if (act?.ok !== true) throw new Error("Could not activate UpdraftPlus on the site");
    activated = true;
    res = await configure(deps, siteId);
  }
  if (res.state !== "configured") throw new Error("UpdraftPlus is still not installed and active");

  const result: BackupSetupResult = {
    installed,
    activated,
    changed: res.changed.slice(0, MAX_CHANGED).map((c) => c.slice(0, MAX_CHANGE_LEN)),
    driveAuthorized: res.drive_authorized,
    legacyDriveFormat: res.legacy_drive_format ?? false,
    nextBackup: res.next_backup,
  };
  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: "site.backup_setup",
    detail: { ...result },
  });
  return result;
}
