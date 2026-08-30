import { connectToSite } from "@/lib/mcp/connect";
import { runPhp } from "@/lib/wpphp";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";
import { enqueueJob } from "@/services/jobs/service";

// No untrusted values: the parent slug is discovered inside WordPress.
export function buildChildThemePhp(activate: boolean): string {
  return `
$parent = get_template();
$current = get_stylesheet();
if ($parent !== $current) { return json_encode(array('ok' => false, 'error' => 'Active theme is already a child theme (' . $current . ')')); }
$slug = $parent . '-child';
$dir = get_theme_root() . '/' . $slug;
if (file_exists($dir)) { return json_encode(array('ok' => false, 'error' => 'Child theme directory already exists: ' . $slug)); }
if (!wp_mkdir_p($dir)) { return json_encode(array('ok' => false, 'error' => 'Could not create theme directory')); }
$theme = wp_get_theme($parent);
$style = "/*\\n" . 'Theme Name: ' . $theme->get('Name') . " Child\\n" . 'Template: ' . $parent . "\\n" . "Version: 1.0.0\\n" . "*/\\n";
if (file_put_contents($dir . '/style.css', $style) === false) { return json_encode(array('ok' => false, 'error' => 'Could not write style.css')); }
$fn = "<?php\\n" . "add_action('wp_enqueue_scripts', function () {\\n" . "  wp_enqueue_style('parent-style', get_template_directory_uri() . '/style.css');\\n" . "});\\n";
if (file_put_contents($dir . '/functions.php', $fn) === false) { return json_encode(array('ok' => false, 'error' => 'Could not write functions.php')); }
${activate ? "switch_theme($slug);" : ""}
return json_encode(array('ok' => true, 'message' => 'Child theme ' . $slug . ' created${activate ? " and activated" : ""}'));
`.trim();
}

export interface ChildThemeDeps { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }

export async function createChildTheme(
  deps: ChildThemeDeps, siteId: string, actorId: string, activate: boolean,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) return { ok: false, error: "Site not found" };

  let output = "";
  let error: string | undefined;
  try {
    const client = await connectToSite(deps.mcp, creds);
    try {
      const result = await runPhp<{ ok: boolean; message?: string; error?: string }>(
        client, buildChildThemePhp(activate), 60_000,
      );
      if (result.ok) output = result.message ?? "Child theme created";
      else error = result.error ?? "Child theme creation failed";
    } finally {
      await client.close();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: "site.child_theme",
    detail: { activate, ok: !error, ...(error ? { error } : { message: output }) },
  });
  if (!error) {
    await enqueueJob(deps.jobs, "snapshot_refresh", siteId, {}, { dedupe: true });
    return { ok: true, output };
  }
  return { ok: false, error };
}
