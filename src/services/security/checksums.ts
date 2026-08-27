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
return json_encode(array('ok' => true, 'checked' => $checked, 'mismatched' => $mismatched, 'missing' => $missing));
`.trim();

interface ChecksumsResult {
  ok: boolean; checked?: number; mismatched?: string[]; missing?: string[]; error?: string;
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
  return {
    check_id: "core_checksums",
    result: mismatched.length > 0 ? "fail" : missing.length > 0 ? "warn" : "pass",
    details: { checked: r.checked, mismatched, missing },
  };
}
