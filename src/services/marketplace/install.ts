import { runPhp, phpString } from "@/lib/wpphp";
import { decryptSecret } from "@/lib/crypto/secrets";
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
  let urlExpr: string;
  if (source.kind === "wporg") {
    if (!SLUG_RE.test(source.slug)) throw new Error(`Invalid slug: ${JSON.stringify(source.slug)}`);
    urlExpr = `'https://downloads.wordpress.org/plugin/' . rawurlencode(${phpString(source.slug)}) . '.latest-stable.zip'`;
  } else {
    if (!/^https:\/\//.test(source.url)) throw new Error("Install URL must be https");
    urlExpr = phpString(source.url);
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
$url = ${urlExpr};
$up = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
$r = $up->install($url);
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
if ($r === false || $r === null) {
  $msgs = $up->skin->get_upgrade_messages();
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
    const client = await deps.mcp({
      endpoint: creds.mcp_endpoint,
      username: creds.wp_username,
      appPassword: await decryptSecret(creds.app_password_encrypted),
    });
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
