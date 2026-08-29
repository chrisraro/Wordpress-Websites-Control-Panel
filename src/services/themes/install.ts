import { phpString } from "@/lib/wpphp";
import { SLUG_RE } from "@/services/manage/service";
import type { InstallSource } from "@/services/marketplace/install";

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

export function buildThemeInstallPhp(source: InstallSource, activate: boolean): string {
  const activatePhp = activate
    ? `
$theme = $up->theme_info();
$stylesheet = $theme ? $theme->get_stylesheet() : null;
if (!$stylesheet) { return json_encode(array('ok' => true, 'message' => 'Installed (activation skipped: stylesheet unknown)')); }
if (get_stylesheet() === $stylesheet) { return json_encode(array('ok' => true, 'message' => 'Installed (already active)', 'slug' => $stylesheet)); }
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
