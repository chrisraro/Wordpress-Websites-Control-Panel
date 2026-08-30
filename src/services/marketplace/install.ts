import { connectToSite } from "@/lib/mcp/connect";
import { runPhp, phpString } from "@/lib/wpphp";
import { SLUG_RE } from "@/services/manage/service";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";
import { enqueueJob } from "@/services/jobs/service";

export type InstallSource = { kind: "wporg"; slug: string } | { kind: "url"; url: string };

const INSTALL_TIMEOUT_MS = 300_000;

const PRELUDE = `
if (!function_exists('get_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/misc.php';
require_once ABSPATH . 'wp-admin/includes/template.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
`;

export function buildInstallPhp(source: InstallSource, activate: boolean): string {
  let sourcePhp: string;
  if (source.kind === "wporg") {
    if (!SLUG_RE.test(source.slug)) throw new Error(`Invalid slug: ${JSON.stringify(source.slug)}`);
    // A plugin directory that already exists makes Plugin_Upgrader->install()
    // fail with folder_exists — deterministic, so short-circuit instead:
    // already installed => success (activating if requested).
    const existingPhp = activate
      ? `
if (is_plugin_active($existing)) { return json_encode(array('ok' => true, 'message' => 'Already installed and active')); }
$e = activate_plugin($existing);
if (is_wp_error($e)) { return json_encode(array('ok' => false, 'error' => 'Already installed; activation failed: ' . $e->get_error_message())); }
return json_encode(array('ok' => true, 'message' => 'Already installed — activated', 'file' => $existing));`
      : `
return json_encode(array('ok' => true, 'message' => 'Already installed', 'file' => $existing));`;
    sourcePhp = `
$slug = ${phpString(source.slug)};
$existing = null;
foreach (array_keys(get_plugins()) as $f) {
  if (dirname($f) === $slug || $f === $slug . '.php') { $existing = $f; break; }
}
if ($existing) {${existingPhp}
}
$url = 'https://downloads.wordpress.org/plugin/' . rawurlencode($slug) . '.latest-stable.zip';
$installArgs = array();`;
  } else {
    if (!/^https:\/\//.test(source.url)) throw new Error("Install URL must be https");
    // Uploads are deliberate (re)installs — e.g. a premium plugin update — so
    // overwriting an existing directory is the intended semantic.
    sourcePhp = `
$url = ${phpString(source.url)};
$installArgs = array('overwrite_package' => true);`;
  }
  const activatePhp = activate
    ? `
$file = $up->plugin_info();
if (!$file) { return json_encode(array('ok' => true, 'message' => 'Installed (activation skipped: main file unknown)')); }
$e = activate_plugin($file);
if (is_wp_error($e)) { return json_encode(array('ok' => false, 'error' => 'Installed but activation failed: ' . $e->get_error_message())); }
return json_encode(array('ok' => true, 'message' => 'Installed and activated', 'file' => $file));`
    : `
$file = $up->plugin_info();
return json_encode(array('ok' => true, 'message' => 'Installed', 'file' => $file));`;

  return `${PRELUDE}
${sourcePhp.trim()}
$up = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
$r = $up->install($url, $installArgs);
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
if ($r === false || $r === null) {
  $msgs = array_map(function ($m) { return preg_replace('/\\?\\S*/', '', (string) $m); }, (array) $up->skin->get_upgrade_messages());
  return json_encode(array('ok' => false, 'error' => 'Install failed: ' . (empty($msgs) ? 'download or filesystem error' : implode(' | ', array_slice($msgs, -3)))));
}
${activatePhp.trim()}`.trim();
}

export interface InstallDeps { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }

export async function installPlugin(
  deps: InstallDeps, siteId: string, actorId: string,
  source: InstallSource, activate: boolean,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const sourceSummary = source.kind === "wporg" ? { kind: source.kind, slug: source.slug } : { kind: source.kind };
  let code: string;
  try {
    code = buildInstallPhp(source, activate);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await deps.sites.insertActivity({
      actor: actorId, site_id: siteId, action: "site.plugin_install",
      detail: { source: sourceSummary, ok: false, error, rejected: "invalid_source" },
    });
    return { ok: false, error };
  }

  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) return { ok: false, error: "Site not found" };

  let output = "";
  let error: string | undefined;
  try {
    const client = await connectToSite(deps.mcp, creds);
    try {
      const result = await runPhp<{ ok: boolean; message?: string; error?: string }>(
        client, code, INSTALL_TIMEOUT_MS,
      );
      if (result.ok) output = result.message ?? "Installed";
      else error = result.error ?? "Install failed";
    } finally {
      await client.close();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: "site.plugin_install",
    detail: { source: sourceSummary, activate, ok: !error, ...(error ? { error } : { message: output }) },
  });
  if (!error) {
    await enqueueJob(deps.jobs, "snapshot_refresh", siteId, {}, { dedupe: true });
    return { ok: true, output };
  }
  return { ok: false, error };
}
