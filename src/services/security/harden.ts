import { connectToSite } from "@/lib/mcp/connect";
import { runPhp, phpString } from "@/lib/wpphp";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import { runPhpHardening, runHttpHardening } from "./hardening";
import type { CheckResult, SecurityCheck } from "./types";

/**
 * Fixes for what the hardening scanner finds.
 *
 * The scanner (hardening.ts) has always reported these; until now the panel
 * offered no way to act on any of them, and every warn cost two points. A site
 * with zero vulnerabilities and six of these is a B.
 *
 * Every fix is one file operation, independently reversible, and none touches
 * wp-config.php or .htaccess. That last part fell out of reading what the
 * checks actually test: DISALLOW_FILE_EDIT is read at runtime by map_meta_cap,
 * which runs after mu-plugins load, so an mu-plugin can define it -- and the
 * one edit that could take a site down entirely is not needed.
 */

export const HARDENING_FIXES = [
  "xmlrpc", "file_edit", "headers", "uploads_index", "wp_config_perms",
] as const;
export type HardeningFix = (typeof HARDENING_FIXES)[number];

export function isHardeningFix(v: unknown): v is HardeningFix {
  return typeof v === "string" && (HARDENING_FIXES as readonly string[]).includes(v);
}

/** The check each fix exists to clear. */
export const FIX_FOR_CHECK: Record<string, HardeningFix> = {
  xmlrpc_enabled: "xmlrpc",
  file_edit_disabled: "file_edit",
  security_headers: "headers",
  uploads_listing: "uploads_index",
  wp_config_permissions: "wp_config_perms",
};
const CHECK_FOR_FIX = Object.fromEntries(
  Object.entries(FIX_FOR_CHECK).map(([c, f]) => [f, c]),
) as Record<HardeningFix, string>;

/** What the dialog says each fix does. Plain words, one line. */
export const FIX_LABEL: Record<HardeningFix, string> = {
  xmlrpc: "Block XML-RPC (breaks Jetpack and the WordPress mobile app if they are in use)",
  file_edit: "Disable the plugin and theme code editors in WP Admin",
  headers: "Send X-Frame-Options, X-Content-Type-Options and Referrer-Policy headers",
  uploads_index: "Stop the uploads folder from listing its files",
  wp_config_perms: "Remove world-read permission from wp-config.php",
};

/**
 * Every failing check that has a fix, as the list of fixes to apply.
 *
 * Deliberately never proposes anything for admin_username (renaming an
 * administrator is not something to do unattended) or inactive_plugins
 * (which plugins to delete is a choice per plugin, and the Plugins tab already
 * offers it with selection).
 */
export function hardeningPlan(checks: SecurityCheck[]): HardeningFix[] {
  const out: HardeningFix[] = [];
  for (const c of checks) {
    if (c.result === "pass") continue;
    const fix = FIX_FOR_CHECK[c.check_id];
    if (fix && !out.includes(fix)) out.push(fix);
  }
  return out;
}

/*
 * The files. Each is a complete mu-plugin, written verbatim via base64 so the
 * PHP that writes it never has to escape anything.
 *
 * Ownership -- "did the panel write this?" -- is decided by the `Plugin Name:
 * OCS Hardening` header, not by the comment below it. The header is what
 * WordPress itself reads, it is present in every version of these files ever
 * written, and it does not move when the product's display name does. The
 * first marker was a sentence containing the product name; the product was
 * renamed the same afternoon, and files already on two sites would have been
 * orphaned. uploads/index.php has no header, so it is owned only if its body
 * is byte-for-byte the silence file -- never a real index.php someone placed.
 */
const OWNED_HEADER = "Plugin Name: OCS Hardening";
const MARKER = "// Written by the control panel. Safe to delete; the panel can re-apply it.";

const MU_XMLRPC = `<?php
/**
 * Plugin Name: OCS Hardening - Disable XML-RPC
 * Description: Answers every XML-RPC request with 403.
 */
${MARKER}
if (defined('XMLRPC_REQUEST') && XMLRPC_REQUEST) {
  status_header(403);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'XML-RPC is disabled on this site.';
  exit;
}
add_filter('xmlrpc_enabled', '__return_false');
remove_action('wp_head', 'rsd_link');
`;

const MU_FILE_EDIT = `<?php
/**
 * Plugin Name: OCS Hardening - Disable File Editing
 * Description: Removes the plugin and theme code editors from WP Admin.
 */
${MARKER}
if (!defined('DISALLOW_FILE_EDIT')) {
  define('DISALLOW_FILE_EDIT', true);
}
`;

const MU_HEADERS = `<?php
/**
 * Plugin Name: OCS Hardening - Security Headers
 * Description: Conservative browser security headers on every response WordPress renders.
 */
${MARKER}
add_action('send_headers', function () {
  if (headers_sent()) { return; }
  header('X-Frame-Options: SAMEORIGIN');
  header('X-Content-Type-Options: nosniff');
  header('Referrer-Policy: strict-origin-when-cross-origin');
});
`;

const UPLOADS_INDEX = `<?php
// Silence is golden.
`;

interface FileFix { path: string; body: string }
const FILE_FIXES: Record<Exclude<HardeningFix, "wp_config_perms">, FileFix> = {
  xmlrpc:        { path: "mu-plugins/ocs-disable-xmlrpc.php", body: MU_XMLRPC },
  file_edit:     { path: "mu-plugins/ocs-disable-file-edit.php", body: MU_FILE_EDIT },
  headers:       { path: "mu-plugins/ocs-security-headers.php", body: MU_HEADERS },
  uploads_index: { path: "uploads/index.php", body: UPLOADS_INDEX },
};

export type FixOutcome = "applied" | "already" | "removed" | "absent" | "failed";
export interface FixResult { fix: HardeningFix; outcome: FixOutcome; reason?: string }

/**
 * PHP that applies (or removes) the requested fixes and reports each one.
 *
 * Paths are relative to WP_CONTENT_DIR, resolved on the site, and every
 * write goes to a temp file then rename(), so a half-written mu-plugin can
 * never be loaded: PHP loads mu-plugins on every request, and a truncated one
 * is a fatal error on every page until someone fixes it by hand.
 *
 * No backslashes anywhere in this string. The file bodies arrive base64'd via
 * phpString, so nothing here needs escaping -- and a test pins that.
 */
export function buildHardenPhp(fixes: HardeningFix[], mode: "harden" | "unharden"): string {
  for (const f of fixes) {
    if (!isHardeningFix(f)) throw new Error(`Unknown hardening fix: ${JSON.stringify(f)}`);
  }
  const fileOps = fixes
    .filter((f): f is Exclude<HardeningFix, "wp_config_perms"> => f !== "wp_config_perms")
    .map((f) => `array(${phpString(f)}, ${phpString(FILE_FIXES[f].path)}, ${phpString(FILE_FIXES[f].body)})`)
    .join(",\n  ");
  const wantPerms = fixes.includes("wp_config_perms");

  return `
$out = array();
$owned = ${phpString(OWNED_HEADER)};
$silence = ${phpString(UPLOADS_INDEX)};
$mode = ${phpString(mode)};
$isOurs = function ($rel, $existing) use ($owned, $silence) {
  if ($rel === 'uploads/index.php') { return trim($existing) === trim($silence) || trim($existing) === ''; }
  return strpos($existing, $owned) !== false;
};
$ops = array(
  ${fileOps}
);
foreach ($ops as $op) {
  list($fix, $rel, $body) = $op;
  $path = rtrim(WP_CONTENT_DIR, '/') . '/' . $rel;
  $dir = dirname($path);
  if ($mode === 'harden') {
    if (!is_dir($dir) && !wp_mkdir_p($dir)) { $out[] = array('fix' => $fix, 'outcome' => 'failed', 'reason' => 'could not create ' . basename($dir)); continue; }
    if (file_exists($path)) {
      $existing = (string) @file_get_contents($path);
      if ($existing === $body) { $out[] = array('fix' => $fix, 'outcome' => 'already'); continue; }
      if (!$isOurs($rel, $existing)) {
        $out[] = array('fix' => $fix, 'outcome' => 'failed', 'reason' => basename($path) . ' exists and was not written by the panel');
        continue;
      }
    }
    $tmp = $path . '.tmp-' . getmypid();
    if (@file_put_contents($tmp, $body) === false) { $out[] = array('fix' => $fix, 'outcome' => 'failed', 'reason' => 'not writable: ' . $dir); continue; }
    if (!@rename($tmp, $path)) { @unlink($tmp); $out[] = array('fix' => $fix, 'outcome' => 'failed', 'reason' => 'rename failed'); continue; }
    $out[] = array('fix' => $fix, 'outcome' => 'applied');
  } else {
    if (!file_exists($path)) { $out[] = array('fix' => $fix, 'outcome' => 'absent'); continue; }
    $existing = (string) @file_get_contents($path);
    if (!$isOurs($rel, $existing)) { $out[] = array('fix' => $fix, 'outcome' => 'failed', 'reason' => basename($path) . ' was not written by the panel; left alone'); continue; }
    if (!@unlink($path)) { $out[] = array('fix' => $fix, 'outcome' => 'failed', 'reason' => 'could not delete'); continue; }
    $out[] = array('fix' => $fix, 'outcome' => 'removed');
  }
}
${wantPerms && mode === "harden" ? `
if (true) {
  $cfg = ABSPATH . 'wp-config.php';
  if (!file_exists($cfg)) { $cfg = dirname(ABSPATH) . '/wp-config.php'; }
  if (!file_exists($cfg)) {
    $out[] = array('fix' => 'wp_config_perms', 'outcome' => 'failed', 'reason' => 'wp-config.php not found');
  } elseif ((fileperms($cfg) & 0007) === 0) {
    $out[] = array('fix' => 'wp_config_perms', 'outcome' => 'already');
  } elseif (@chmod($cfg, 0640)) {
    clearstatcache(true, $cfg);
    if ((fileperms($cfg) & 0007) === 0) { $out[] = array('fix' => 'wp_config_perms', 'outcome' => 'applied'); }
    else { $out[] = array('fix' => 'wp_config_perms', 'outcome' => 'failed', 'reason' => 'permissions did not change'); }
  } else {
    $out[] = array('fix' => 'wp_config_perms', 'outcome' => 'failed', 'reason' => 'chmod refused (PHP is not the file owner)');
  }
}
` : ""}
return json_encode($out);
`.trim();
}

export interface HardenDeps {
  sites: SitesRepo;
  mcp: McpFactory;
  fetchImpl?: typeof fetch;
}

export interface CheckDelta { check_id: string; before: CheckResult | null; after: CheckResult | null }
export interface HardenOutcome {
  ok: boolean;
  results: FixResult[];
  /** The targeted checks, re-run after the fixes. */
  checks: CheckDelta[];
  error?: string;
}

/**
 * Applies fixes, then re-runs the checks they target and reports both.
 *
 * "Applied" and "the check now passes" are kept separate on purpose. They can
 * differ: a static page cache serves yesterday's headers, a CDN answers for
 * xmlrpc.php before WordPress does. The operator needs to see which happened,
 * because the next step is different in each case.
 */
export async function hardenSite(
  deps: HardenDeps, siteId: string, actorId: string, fixes: HardeningFix[],
  mode: "harden" | "unharden" = "harden",
): Promise<HardenOutcome> {
  if (fixes.length === 0) return { ok: false, results: [], checks: [], error: "Nothing to apply" };

  let code: string;
  try {
    code = buildHardenPhp(fixes, mode);
  } catch (e) {
    return { ok: false, results: [], checks: [], error: e instanceof Error ? e.message : String(e) };
  }

  const creds = await deps.sites.getSiteCredentials(siteId);
  const site = await deps.sites.getSite(siteId);
  if (!creds || !site) return { ok: false, results: [], checks: [], error: "Site not found" };

  const targeted = new Set(fixes.map((f) => CHECK_FOR_FIX[f]));
  const pick = (all: SecurityCheck[]) =>
    new Map(all.filter((c) => targeted.has(c.check_id)).map((c) => [c.check_id, c.result]));

  let results: FixResult[] = [];
  let before = new Map<string, CheckResult>();
  let after = new Map<string, CheckResult>();
  let error: string | undefined;
  try {
    const client = await connectToSite(deps.mcp, creds);
    try {
      const measure = async () => pick([
        ...(await runPhpHardening(client)),
        ...(await runHttpHardening(site.url, deps.fetchImpl)),
      ]);
      before = await measure();
      results = await runPhp<FixResult[]>(client, code, 120_000);
      after = await measure();
    } finally {
      await client.close();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const checks: CheckDelta[] = [...targeted].map((id) => ({
    check_id: id, before: before.get(id) ?? null, after: after.get(id) ?? null,
  }));
  const ok = !error && results.every((r) => r.outcome !== "failed");

  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: `site.security.${mode}`,
    detail: { fixes, results, checks, ok, ...(error ? { error } : {}) },
  });

  return { ok, results, checks, ...(error ? { error } : {}) };
}

/**
 * One sentence per outcome, for a toast. Says "applied" and "now passes"
 * separately, because a cache in front of the site can hold the old answer
 * after the fix is genuinely in place -- seen live on the first real run,
 * where nginx served a homepage cached before the headers mu-plugin existed.
 */
export function summarizeHardening(out: HardenOutcome): { message?: string; error?: string } {
  const applied = out.results.filter((r) => r.outcome === "applied").map((r) => r.fix);
  const already = out.results.filter((r) => r.outcome === "already").length;
  const failed = out.results.filter((r) => r.outcome === "failed");
  const stillFailing = out.checks.filter((c) => c.after !== "pass" && c.after !== null);

  const parts: string[] = [];
  if (applied.length) parts.push(`Applied ${applied.length} fix${applied.length === 1 ? "" : "es"}.`);
  if (already) parts.push(`${already} already in place.`);
  if (stillFailing.length) {
    parts.push(
      `${stillFailing.map((c) => c.check_id).join(", ")} still ${stillFailing.length === 1 ? "warns" : "warn"} — ` +
      "usually a cache in front of the site serving an older copy; it clears on its own, or flush the site's cache.",
    );
  }
  if (failed.length) {
    return {
      ...(parts.length ? { message: parts.join(" ") } : {}),
      error: failed.map((f) => `${f.fix}: ${f.reason ?? "failed"}`).join("; "),
    };
  }
  return { message: parts.join(" ") || "Done." };
}
