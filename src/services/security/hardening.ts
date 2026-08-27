import { runPhp } from "@/lib/wpphp";
import type { SiteMcpClient } from "@/lib/mcp/client";
import type { CheckResult, SecurityCheck } from "./types";

export const HARDENING_PHP = `
$checks = array();
$add = function ($id, $result, $details = null) use (&$checks) {
  $checks[] = array('check_id' => $id, 'result' => $result, 'details' => $details);
};
$add('wp_debug', (defined('WP_DEBUG') && WP_DEBUG) ? 'fail' : 'pass');
$add('debug_display', (defined('WP_DEBUG') && WP_DEBUG && (!defined('WP_DEBUG_DISPLAY') || WP_DEBUG_DISPLAY)) ? 'fail' : 'pass');
$add('file_edit_disabled', (defined('DISALLOW_FILE_EDIT') && DISALLOW_FILE_EDIT) ? 'pass' : 'warn');
$https = (strpos(get_option('siteurl'), 'https://') === 0) && (strpos(get_option('home'), 'https://') === 0);
$add('https_urls', $https ? 'pass' : 'fail');
global $wpdb;
$add('default_table_prefix', $wpdb->prefix === 'wp_' ? 'warn' : 'pass', array('prefix' => $wpdb->prefix));
$adminUser = get_user_by('login', 'admin');
$add('admin_username', $adminUser ? 'fail' : 'pass');
$badSalt = defined('AUTH_KEY') ? (strpos(AUTH_KEY, 'put your unique phrase') !== false || strlen(AUTH_KEY) < 32) : true;
$add('default_salts', $badSalt ? 'fail' : 'pass');
$add('user_registration', get_option('users_can_register') ? 'warn' : 'pass');
$php = PHP_VERSION;
$add('php_version', version_compare($php, '8.0', '>=') ? 'pass' : (version_compare($php, '7.4', '>=') ? 'warn' : 'fail'), array('version' => $php));
if (!function_exists('get_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
$active = (array) get_option('active_plugins', array());
$inactive = 0;
foreach (array_keys(get_plugins()) as $file) { if (!in_array($file, $active, true)) { $inactive++; } }
$add('inactive_plugins', $inactive === 0 ? 'pass' : 'warn', array('count' => $inactive));
$cfg = ABSPATH . 'wp-config.php';
if (!file_exists($cfg)) { $cfg = dirname(ABSPATH) . '/wp-config.php'; }
$perms = file_exists($cfg) ? (fileperms($cfg) & 0007) : null;
$add('wp_config_permissions', ($perms === null) ? 'warn' : (($perms & 0002) ? 'fail' : ($perms === 0 ? 'pass' : 'warn')), array('world_bits' => $perms));
return json_encode($checks);
`.trim();

export async function runPhpHardening(client: SiteMcpClient): Promise<SecurityCheck[]> {
  return runPhp<SecurityCheck[]>(client, HARDENING_PHP, 60_000);
}

async function probe(
  fetchImpl: typeof fetch, url: string,
): Promise<{ status: number; body: string; headers: Headers } | null> {
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    const body = (await res.text()).slice(0, 4096);
    return { status: res.status, body, headers: res.headers };
  } catch {
    return null;
  }
}

export async function runHttpHardening(
  siteUrl: string, fetchImpl: typeof fetch = fetch,
): Promise<SecurityCheck[]> {
  const base = siteUrl.replace(/\/+$/, "");
  const [xmlrpc, uploads, home] = await Promise.all([
    probe(fetchImpl, `${base}/xmlrpc.php`),
    probe(fetchImpl, `${base}/wp-content/uploads/`),
    probe(fetchImpl, `${base}/`),
  ]);

  const checks: SecurityCheck[] = [];
  // GET on xmlrpc.php returns 405 ("POST only") when the endpoint is live.
  const xmlrpcResult: CheckResult =
    xmlrpc === null ? "warn" : xmlrpc.status === 405 || (xmlrpc.status === 200 && xmlrpc.body.includes("XML-RPC")) ? "warn" : "pass";
  checks.push({ check_id: "xmlrpc_enabled", result: xmlrpcResult, details: { status: xmlrpc?.status ?? "unreachable" } });

  const listingOpen = uploads !== null && uploads.status === 200 && /index of/i.test(uploads.body);
  checks.push({
    check_id: "uploads_listing",
    result: uploads === null ? "warn" : listingOpen ? "fail" : "pass",
    details: { status: uploads?.status ?? "unreachable" },
  });

  const hasFrameHeader = home !== null &&
    (home.headers.has("x-frame-options") || home.headers.has("content-security-policy"));
  checks.push({
    check_id: "security_headers",
    result: home === null ? "warn" : hasFrameHeader ? "pass" : "warn",
    details: { status: home?.status ?? "unreachable" },
  });
  return checks;
}
