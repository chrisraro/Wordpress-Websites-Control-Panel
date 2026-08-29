import { phpString, runPhp } from "@/lib/wpphp";
import { decryptSecret } from "@/lib/crypto/secrets";
import { SLUG_RE } from "@/services/manage/service";
import type { InstallSource } from "@/services/marketplace/install";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";
import { enqueueJob } from "@/services/jobs/service";

export const THEME_INSTALL_TIMEOUT_MS = 300_000;

// Guarded on functions that genuinely live in these files. get_themes() is a
// deprecated always-loaded shim, so guarding on it silently skips the require.
const PRELUDE = `
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/misc.php';
require_once ABSPATH . 'wp-admin/includes/template.php';
require_once ABSPATH . 'wp-admin/includes/theme.php';
require_once ABSPATH . 'wp-admin/includes/theme-install.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
global $wp_filesystem; WP_Filesystem();
`;

// Same parentage check `buildPhp("activate_theme")` uses in
// src/services/manage/service.ts, duplicated here rather than shared because
// the two live in separate PHP snippet builders with no common runtime.
// `var` names the PHP variable holding the stylesheet slug to check; the
// activation is skipped (not failed) so a successful install is never
// reported as having failed just because the operator also asked to
// activate — see the "Installed (activation skipped: ...)" precedent right
// below for the same shape used when the stylesheet itself is unknown.
function skipActivationIfParentMissing(varName: string, installedMessage: string): string {
  return `
$__t = wp_get_theme(${varName});
$__parent = $__t->get_template();
if ($__parent && $__parent !== ${varName} && !wp_get_theme($__parent)->exists()) {
  return json_encode(array('ok' => true, 'message' => '${installedMessage} (activation skipped: parent theme ' . $__parent . ' is not installed)', 'slug' => ${varName}));
}`;
}

export function buildThemeInstallPhp(source: InstallSource, activate: boolean): string {
  const activatePhp = activate
    ? `
$theme = $up->theme_info();
$stylesheet = $theme ? $theme->get_stylesheet() : null;
if (!$stylesheet) { return json_encode(array('ok' => true, 'message' => 'Installed (activation skipped: stylesheet unknown)')); }
if (get_stylesheet() === $stylesheet) { return json_encode(array('ok' => true, 'message' => 'Installed (already active)', 'slug' => $stylesheet)); }
${skipActivationIfParentMissing("$stylesheet", "Installed")}
switch_theme($stylesheet);
return json_encode(array('ok' => true, 'message' => 'Installed and activated', 'slug' => $stylesheet));`
    : `
return json_encode(array('ok' => true, 'message' => 'Theme installed'));`;

  let sourcePhp: string;
  if (source.kind === "wporg") {
    if (!SLUG_RE.test(source.slug)) throw new Error(`Invalid slug: ${JSON.stringify(source.slug)}`);
    const existingPhp = activate
      ? `
if (get_stylesheet() === $slug) { return json_encode(array('ok' => true, 'message' => 'Already installed and active', 'slug' => $slug)); }
${skipActivationIfParentMissing("$slug", "Already installed")}
switch_theme($slug);
return json_encode(array('ok' => true, 'message' => 'Already installed — activated', 'slug' => $slug));`
      : `
return json_encode(array('ok' => true, 'message' => 'Already installed', 'slug' => $slug));`;
    sourcePhp = `
$slug = ${phpString(source.slug)};
if (wp_get_theme($slug)->exists()) {${existingPhp}
}
$api = themes_api('theme_information', array('slug' => $slug, 'fields' => array('sections' => false)));
if (is_wp_error($api)) { return json_encode(array('ok' => false, 'error' => 'wordpress.org lookup failed: ' . $api->get_error_message())); }
if (empty($api->download_link)) { return json_encode(array('ok' => false, 'error' => 'No download link for that theme')); }
$url = $api->download_link;
$installArgs = array();`;
  } else {
    if (!/^https:\/\//.test(source.url)) throw new Error("Install URL must be https");
    // Uploads are deliberate (re)installs, so overwriting is the intent.
    sourcePhp = `
$url = ${phpString(source.url)};
$installArgs = array('overwrite_package' => true);`;
  }

  return `${PRELUDE}${sourcePhp}
$up = new Theme_Upgrader(new Automatic_Upgrader_Skin());
$res = $up->install($url, $installArgs);
if (is_wp_error($res)) { return json_encode(array('ok' => false, 'error' => $res->get_error_message())); }
if ($res === false || $res === null) {
  $msgs = array_map(function ($m) { return preg_replace('/\\?\\S*/', '', (string) $m); }, (array) $up->skin->get_upgrade_messages());
  return json_encode(array('ok' => false, 'error' => 'Install failed: ' . (empty($msgs) ? 'download or filesystem error' : implode(' | ', array_slice($msgs, -3)))));
}
${activatePhp}`.trim();
}

export interface ThemeInstallDeps { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }

/**
 * Runs a theme install/activate inline, the same way `createChildTheme` and
 * every other per-site manage action does — no job queue, just an awaited MCP
 * round-trip. `installPlugin` in the marketplace only queues because it fans
 * a single click out across many sites; a per-site installer has exactly one
 * site to talk to, so there is nothing for a job to buy here.
 */
export async function installTheme(
  deps: ThemeInstallDeps, siteId: string, actorId: string,
  source: InstallSource, activate: boolean,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const sourceSummary = source.kind === "wporg" ? { kind: source.kind, slug: source.slug } : { kind: source.kind };
  let code: string;
  try {
    code = buildThemeInstallPhp(source, activate);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await deps.sites.insertActivity({
      actor: actorId, site_id: siteId, action: "site.theme_install",
      detail: { source: sourceSummary, ok: false, error, rejected: "invalid_source" },
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
        client, code, THEME_INSTALL_TIMEOUT_MS,
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
    actor: actorId, site_id: siteId, action: "site.theme_install",
    detail: { source: sourceSummary, activate, ok: !error, ...(error ? { error } : { message: output }) },
  });
  if (!error) {
    await enqueueJob(deps.jobs, "snapshot_refresh", siteId, {}, { dedupe: true });
    return { ok: true, output };
  }
  return { ok: false, error };
}
