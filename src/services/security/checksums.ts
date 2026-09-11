import { runPhp } from "@/lib/wpphp";
import type { SiteMcpClient } from "@/lib/mcp/client";
import type { SecurityCheck } from "./types";

export const CHECKSUMS_PHP = `
global $wp_version, $wp_local_package;
$locale = !empty($wp_local_package) ? $wp_local_package : 'en_US';
$url = 'https://api.wordpress.org/core/checksums/1.0/?version=' . rawurlencode($wp_version) . '&locale=' . rawurlencode($locale);
$resp = wp_remote_get($url, array('timeout' => 30));
if (is_wp_error($resp)) { return json_encode(array('ok' => false, 'error' => $resp->get_error_message())); }
$body = json_decode(wp_remote_retrieve_body($resp), true);
$sums = (isset($body['checksums']) && is_array($body['checksums'])) ? $body['checksums'] : null;
if (!$sums) { return json_encode(array('ok' => false, 'error' => 'No checksums published for WordPress ' . $wp_version . ' (' . $locale . ')')); }
$mismatched = array(); $missing = array(); $checked = 0;
foreach ($sums as $file => $md5) {
  if (strpos($file, 'wp-content/') === 0) { continue; }
  $checked++;
  $path = ABSPATH . $file;
  if (!file_exists($path)) { if (count($missing) < 50) { $missing[] = $file; } continue; }
  if (md5_file($path) !== $md5) { if (count($mismatched) < 50) { $mismatched[] = $file; } }
}
// Files that exist inside wp-admin or wp-includes but are not in the manifest.
// The manifest lists what WordPress ships; anything else in those two
// directories was put there by something that is not WordPress. Only PHP is
// reported -- a stray .DS_Store is noise, a stray .php is a shell.
$unknown = array();
$abs = rtrim(ABSPATH, '/') . '/';
foreach (array('wp-admin', 'wp-includes') as $dir) {
  if (!is_dir($abs . $dir)) { continue; }
  $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($abs . $dir, FilesystemIterator::SKIP_DOTS));
  foreach ($it as $f) {
    if (!$f->isFile() || !preg_match('/[.](php|phtml|phar|inc)$/i', $f->getFilename())) { continue; }
    $rel = str_replace(chr(92), '/', substr($f->getPathname(), strlen($abs)));
    if (!isset($sums[$rel])) { if (count($unknown) < 50) { $unknown[] = $rel; } }
  }
}
return json_encode(array('ok' => true, 'checked' => $checked, 'mismatched' => $mismatched, 'missing' => $missing, 'unknown' => $unknown));
`.trim();

interface ChecksumsResult {
  ok: boolean; checked?: number; mismatched?: string[]; missing?: string[]; unknown?: string[]; error?: string;
}

export async function runChecksums(client: SiteMcpClient): Promise<SecurityCheck> {
  let r: ChecksumsResult;
  try {
    r = await runPhp<ChecksumsResult>(client, CHECKSUMS_PHP, 180_000);
  } catch (e) {
    return {
      check_id: "core_checksums", result: "warn",
      details: { error: e instanceof Error ? e.message : String(e) },
    };
  }
  if (!r.ok) return { check_id: "core_checksums", result: "warn", details: { error: r.error } };
  const mismatched = r.mismatched ?? [];
  const missing = r.missing ?? [];
  // A PHP file in wp-admin or wp-includes that WordPress did not ship is a
  // fail, the same as a modified one. This is the gap an incident on this
  // fleet went through: two shells named to look like core --
  // class-wp-tax-query-Misc.php, blocks/post-excerpt-Int32.php -- sat beside
  // the real files, and a scan that only compared known files could not see
  // them. The modified core file it DID catch was the loader that
  // reinstalled them.
  const unknown = r.unknown ?? [];
  return {
    check_id: "core_checksums",
    result: mismatched.length > 0 || unknown.length > 0 ? "fail" : missing.length > 0 ? "warn" : "pass",
    details: { checked: r.checked, mismatched, missing, unknown },
  };
}
