import { runPhp, phpString } from "@/lib/wpphp";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";
import { enqueueJob } from "@/services/jobs/service";
import type { ManageAction } from "./types";

/** Theme stylesheet slugs: alnum first char, then alnum/dot/underscore/dash. */
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;
/** Plugin basenames: "dir/file.php" or "file.php", each segment alnum-first. */
export const PLUGIN_FILE_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?\.php$/i;

const ACTION_TIMEOUT_MS = 180_000;
// update-all / core update download + unpack. Kept below the pages'
// maxDuration (300s) so the friendly error path runs before the platform
// kills the function.
const HEAVY_TIMEOUT_MS = 270_000;

function pluginFile(f: string): string {
  if (!PLUGIN_FILE_RE.test(f)) throw new Error(`Invalid plugin file: ${JSON.stringify(f)}`);
  return f;
}
function themeSlug(s: string): string {
  if (!SLUG_RE.test(s)) throw new Error(`Invalid slug: ${JSON.stringify(s)}`);
  return s;
}

const UPGRADER_PRELUDE = `
if (!function_exists('get_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
if (!function_exists('wp_update_plugins')) { require_once ABSPATH . 'wp-includes/update.php'; }
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/misc.php';
require_once ABSPATH . 'wp-admin/includes/template.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
`;

// Literal ASCII messages only — anything dynamic must go through phpString().
const OK = (msg: string) => `return json_encode(array('ok' => true, 'message' => '${msg}'));`;

/** Generate the PHP snippet for an action. Untrusted values travel as base64. */
export function buildPhp(action: ManageAction): string {
  switch (action.kind) {
    case "activate_plugin":
      return `
if (!function_exists('activate_plugin')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
$f = ${phpString(pluginFile(action.file))};
$r = activate_plugin($f);
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
${OK("Plugin activated")}`.trim();

    case "deactivate_plugin":
      return `
if (!function_exists('deactivate_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
$f = ${phpString(pluginFile(action.file))};
deactivate_plugins(array($f));
${OK("Plugin deactivated")}`.trim();

    case "update_plugin":
      return `${UPGRADER_PRELUDE}
$f = ${phpString(pluginFile(action.file))};
wp_update_plugins();
$up = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
$res = $up->bulk_upgrade(array($f));
$r = (is_array($res) && array_key_exists($f, $res)) ? $res[$f] : false;
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
if ($r === false || $r === null) { return json_encode(array('ok' => false, 'error' => 'Update failed (filesystem error or no update available)')); }
${OK("Plugin updated")}`.trim();

    case "update_all_plugins":
      return `${UPGRADER_PRELUDE}
wp_update_plugins();
$pu = get_site_transient('update_plugins');
$files = (is_object($pu) && !empty($pu->response)) ? array_keys((array) $pu->response) : array();
if (!$files) { return json_encode(array('ok' => true, 'message' => 'Nothing to update')); }
$up = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
$res = $up->bulk_upgrade($files);
if (!is_array($res)) { return json_encode(array('ok' => false, 'error' => 'Bulk upgrade could not start (filesystem access?)')); }
$failed = array();
foreach ((array) $res as $file => $r) { if ($r === false || $r === null || is_wp_error($r)) { $failed[] = $file; } }
if ($failed) { return json_encode(array('ok' => false, 'error' => 'Failed: ' . implode(', ', $failed))); }
return json_encode(array('ok' => true, 'message' => 'Updated ' . count((array) $res) . ' plugin(s)'));`.trim();

    case "update_theme":
      return `${UPGRADER_PRELUDE}
$s = ${phpString(themeSlug(action.slug))};
wp_update_themes();
$up = new Theme_Upgrader(new Automatic_Upgrader_Skin());
$res = $up->bulk_upgrade(array($s));
$r = (is_array($res) && array_key_exists($s, $res)) ? $res[$s] : false;
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
if ($r === false || $r === null) { return json_encode(array('ok' => false, 'error' => 'Update failed (filesystem error or no update available)')); }
${OK("Theme updated")}`.trim();

    case "update_core":
      return `${UPGRADER_PRELUDE}
require_once ABSPATH . 'wp-admin/includes/update.php';
wp_version_check();
$update = false;
foreach ((array) get_core_updates() as $u) { if (isset($u->response) && $u->response === 'upgrade') { $update = $u; break; } }
if (!$update) { return json_encode(array('ok' => true, 'message' => 'Core already up to date')); }
$up = new Core_Upgrader(new Automatic_Upgrader_Skin());
$r = $up->upgrade($update);
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
if ($r === false || $r === null) { return json_encode(array('ok' => false, 'error' => 'Core update failed (filesystem error)')); }
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
wp_upgrade();
return json_encode(array('ok' => true, 'message' => 'Core updated to ' . $update->version . ' (DB upgraded)'));`.trim();

    case "delete_plugin":
      // delete_plugins() fires each plugin's uninstall hook, which routinely
      // drops its tables and options. The UI names that consequence; here we
      // only guarantee we never do it to a running plugin.
      return `
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
global $wp_filesystem;
// WP_Filesystem() can fail (e.g. no direct filesystem access and no FTP_*
// creds in wp-config.php). If we ignore that and call delete_plugins()
// anyway, core's own request_filesystem_credentials() fallback kicks in,
// which can require_once the wp-admin header and echo/exit mid-request,
// breaking the JSON contract this whole feature relies on. Bail here instead.
if (!WP_Filesystem()) { return json_encode(array('ok' => false, 'error' => 'Could not access the filesystem on this host')); }
$f = ${phpString(pluginFile(action.file))};
if (!array_key_exists($f, get_plugins())) { return json_encode(array('ok' => false, 'error' => 'Plugin is not installed')); }
if (is_plugin_active($f) || is_plugin_active_for_network($f)) {
  return json_encode(array('ok' => false, 'error' => 'Deactivate the plugin before deleting it'));
}
$r = delete_plugins(array($f));
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
if ($r === false || $r === null) { return json_encode(array('ok' => false, 'error' => 'Delete failed (filesystem error)')); }
${OK("Plugin deleted")}`.trim();

    case "activate_theme":
      return `
require_once ABSPATH . 'wp-admin/includes/theme.php';
$s = ${phpString(themeSlug(action.slug))};
$t = wp_get_theme($s);
if (!$t->exists()) { return json_encode(array('ok' => false, 'error' => 'Theme is not installed')); }
$parent = $t->get_template();
if ($parent && $parent !== $s && !wp_get_theme($parent)->exists()) {
  return json_encode(array('ok' => false, 'error' => 'Parent theme ' . $parent . ' is not installed'));
}
switch_theme($s);
if (get_stylesheet() !== $s) { return json_encode(array('ok' => false, 'error' => 'WordPress did not switch themes')); }
${OK("Theme activated")}`.trim();

    case "delete_theme":
      // The gate also lives in TypeScript (services/themes/safety.ts) to drive
      // the UI, but that reads a snapshot which can be stale. This copy runs
      // against live state and is the one that actually protects the site.
      return `
require_once ABSPATH . 'wp-admin/includes/theme.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
global $wp_filesystem;
// WP_Filesystem() can fail (e.g. no direct filesystem access and no FTP_*
// creds in wp-config.php). If we ignore that and call delete_theme()
// anyway, core's own request_filesystem_credentials() fallback kicks in,
// which can require_once the wp-admin header and echo/exit mid-request,
// breaking the JSON contract this whole feature relies on. Bail here instead.
if (!WP_Filesystem()) { return json_encode(array('ok' => false, 'error' => 'Could not access the filesystem on this host')); }
$s = ${phpString(themeSlug(action.slug))};
$all = wp_get_themes();
if (!isset($all[$s])) { return json_encode(array('ok' => false, 'error' => 'Theme is not installed')); }
if (count($all) <= 1) { return json_encode(array('ok' => false, 'error' => 'This is the only theme installed')); }
if ($s === get_stylesheet()) { return json_encode(array('ok' => false, 'error' => 'Theme is active')); }
if ($s === get_template()) { return json_encode(array('ok' => false, 'error' => 'Theme is the parent of the active theme')); }
foreach ($all as $slug => $t) {
  if ($slug !== $s && $t->get_template() === $s) {
    return json_encode(array('ok' => false, 'error' => 'Theme is the parent of ' . $slug));
  }
}
$r = delete_theme($s);
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
if ($r === false || $r === null) { return json_encode(array('ok' => false, 'error' => 'Delete failed (filesystem error)')); }
${OK("Theme deleted")}`.trim();

    case "maintenance":
      return action.enable
        ? `
$r = file_put_contents(ABSPATH . '.maintenance', '<?php $upgrading = ' . time() . ';');
if ($r === false) { return json_encode(array('ok' => false, 'error' => 'Could not write .maintenance file')); }
${OK("Maintenance mode enabled")}`.trim()
        : `
if (file_exists(ABSPATH . '.maintenance') && !unlink(ABSPATH . '.maintenance')) {
  return json_encode(array('ok' => false, 'error' => 'Could not remove .maintenance file'));
}
${OK("Maintenance mode disabled")}`.trim();

    case "flush_cache":
      return `wp_cache_flush();\n${OK("Cache flushed")}`;

    case "flush_permalinks":
      return `flush_rewrite_rules(true);\n${OK("Rewrite rules flushed")}`;
  }
}

function timeoutFor(action: ManageAction): number {
  return action.kind === "update_all_plugins" || action.kind === "update_core"
    ? HEAVY_TIMEOUT_MS
    : ACTION_TIMEOUT_MS;
}

export interface ManageDeps { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }

export async function manageSite(
  deps: ManageDeps, siteId: string, actorId: string, action: ManageAction,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  let code: string;
  try {
    code = buildPhp(action);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await deps.sites.insertActivity({
      actor: actorId, site_id: siteId, action: `site.manage.${action.kind}`,
      detail: { action: { kind: action.kind }, ok: false, error, rejected: "invalid_target" },
    });
    return { ok: false, error };
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
      const result = await runPhp<{ ok: boolean; message?: string; error?: string }>(
        client, code, timeoutFor(action),
      );
      if (result.ok) {
        output = result.message ?? "Done";
      } else {
        error = result.error ?? "Action failed";
      }
    } finally {
      await client.close();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: `site.manage.${action.kind}`,
    detail: { action, ok: !error, ...(error ? { error } : { message: output }) },
  });
  if (!error) {
    await enqueueJob(deps.jobs, "snapshot_refresh", siteId, {}, { dedupe: true });
    return { ok: true, output };
  }
  return { ok: false, error };
}
