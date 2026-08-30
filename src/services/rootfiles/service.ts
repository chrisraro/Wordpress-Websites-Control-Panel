import { runPhp, phpString } from "@/lib/wpphp";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import {
  ALLOWED_EXTENSIONS, MAX_ROOT_FILE_BYTES, WP_CORE_ROOT_FILES,
  validateRootFileName, type RootFile,
} from "./types";

const TIMEOUT_MS = 60_000;

export interface RootFilesDeps {
  repo: SitesRepo;
  mcp: McpFactory;
}

async function connect(deps: RootFilesDeps, siteId: string) {
  const creds = await deps.repo.getSiteCredentials(siteId);
  if (!creds) throw new Error("Site not found");
  return deps.mcp({
    endpoint: creds.mcp_endpoint,
    username: creds.wp_username,
    appPassword: await decryptSecret(creds.app_password_encrypted),
  });
}

/**
 * The PHP-side allowlist, kept identical in shape to ROOT_FILE_RE.
 *
 * Deliberately duplicated rather than passed in from TypeScript. The name
 * arrives as an untrusted string and the only thing standing between it and
 * the filesystem is a check; doing that check once, on the far side of a
 * network boundary, in the same language that performs the write, means a
 * future refactor of the TypeScript cannot silently remove it. The extra
 * `basename()` equality test catches any separator this regex somehow
 * admits, including on a host with unusual path semantics.
 */
const PHP_GUARD = `
$allowed = ${phpString(ALLOWED_EXTENSIONS.join("|"))};
if ($name !== basename($name)) { return json_encode(array('ok' => false, 'error' => 'Invalid file name')); }
if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]*\\.(' . $allowed . ')$/', $name)) {
  return json_encode(array('ok' => false, 'error' => 'Invalid file name'));
}
$blocked = ${phpString([...WP_CORE_ROOT_FILES].join("|"))};
if (in_array($name, explode('|', $blocked), true)) {
  return json_encode(array('ok' => false, 'error' => 'That is a WordPress core file'));
}
$path = ABSPATH . $name;
// realpath() resolves symlinks, so this asserts the directory the write
// actually lands in is still the document root. The name is already known to
// contain no separator, but a symlink placed at that name could otherwise
// redirect the write elsewhere on the filesystem.
if (realpath(dirname($path)) !== realpath(ABSPATH)) {
  return json_encode(array('ok' => false, 'error' => 'Resolved outside the document root'));
}
`.trim();

/**
 * Lists the static files a person has put in the document root.
 *
 * Excludes directories and every WordPress core file, so the result is "what
 * has been added here", which is the question the UI is asking. Anything
 * with an extension outside the allowlist is also excluded -- this feature
 * cannot write those, so offering to delete them would imply a control it
 * does not have.
 */
export async function listRootFiles(
  deps: RootFilesDeps, siteId: string,
): Promise<RootFile[]> {
  const client = await connect(deps, siteId);
  try {
    const res = await runPhp<{ ok: boolean; files?: RootFile[]; error?: string }>(
      client,
      `
$allowed = explode('|', ${phpString(ALLOWED_EXTENSIONS.join("|"))});
$core = explode('|', ${phpString([...WP_CORE_ROOT_FILES].join("|"))});
$out = array();
$dh = @opendir(ABSPATH);
if ($dh === false) { return json_encode(array('ok' => false, 'error' => 'Could not read the document root')); }
while (($f = readdir($dh)) !== false) {
  if ($f === '.' || $f === '..') { continue; }
  $p = ABSPATH . $f;
  if (!is_file($p)) { continue; }
  if (in_array($f, $core, true)) { continue; }
  $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
  if (!in_array($ext, $allowed, true)) { continue; }
  $out[] = array(
    'name' => $f,
    'bytes' => (int) filesize($p),
    'modified' => (int) filemtime($p),
    'url' => home_url('/' . $f),
  );
}
closedir($dh);
usort($out, function ($a, $b) { return strcmp($a['name'], $b['name']); });
return json_encode(array('ok' => true, 'files' => $out));`.trim(),
      TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(res.error ?? "Could not list files");
    return res.files ?? [];
  } finally {
    await client.close();
  }
}

/**
 * Writes one static file into the document root, creating or replacing it.
 *
 * Returns the public URL and a sha256 of what actually landed on disk, read
 * back after the write. That read-back is the point: this project has
 * repeatedly found that a call reporting success and the live system
 * disagreeing are different things, and a verification file that is subtly
 * wrong fails silently weeks later when someone checks Search Console.
 */
export async function putRootFile(
  deps: RootFilesDeps, siteId: string, name: string, content: Buffer,
): Promise<{ url: string; bytes: number; sha256: string; replaced: boolean }> {
  const nameError = validateRootFileName(name);
  if (nameError) throw new Error(nameError);
  if (content.byteLength === 0) throw new Error("That file is empty.");
  if (content.byteLength > MAX_ROOT_FILE_BYTES) {
    throw new Error(
      `That file is ${Math.ceil(content.byteLength / 1024)} KB. The limit is ${MAX_ROOT_FILE_BYTES / 1024} KB.`,
    );
  }

  const client = await connect(deps, siteId);
  try {
    const res = await runPhp<{
      ok: boolean; url?: string; bytes?: number; sha256?: string; replaced?: boolean; error?: string;
    }>(
      client,
      `
$name = ${phpString(name)};
${PHP_GUARD}
$data = base64_decode(${phpString(content.toString("base64"))}, true);
if ($data === false) { return json_encode(array('ok' => false, 'error' => 'Payload was not valid base64')); }
$replaced = file_exists($path);
if (!is_writable(ABSPATH)) { return json_encode(array('ok' => false, 'error' => 'The document root is not writable')); }
$w = file_put_contents($path, $data);
if ($w === false) { return json_encode(array('ok' => false, 'error' => 'The write failed')); }
@chmod($path, 0644);
// Read back rather than trusting the write: bytes reported and bytes on
// disk are different claims.
clearstatcache(true, $path);
return json_encode(array(
  'ok' => true,
  'url' => home_url('/' . $name),
  'bytes' => (int) filesize($path),
  'sha256' => hash_file('sha256', $path),
  'replaced' => $replaced
));`.trim(),
      TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(res.error ?? "The upload failed");
    return {
      url: res.url ?? "",
      bytes: res.bytes ?? 0,
      sha256: res.sha256 ?? "",
      replaced: res.replaced ?? false,
    };
  } finally {
    await client.close();
  }
}

/** Removes one file this feature could have written. */
export async function deleteRootFile(
  deps: RootFilesDeps, siteId: string, name: string,
): Promise<void> {
  const nameError = validateRootFileName(name);
  if (nameError) throw new Error(nameError);

  const client = await connect(deps, siteId);
  try {
    const res = await runPhp<{ ok: boolean; error?: string }>(
      client,
      `
$name = ${phpString(name)};
${PHP_GUARD}
if (!file_exists($path)) { return json_encode(array('ok' => false, 'error' => 'That file is already gone')); }
if (!@unlink($path)) { return json_encode(array('ok' => false, 'error' => 'The delete failed')); }
return json_encode(array('ok' => true));`.trim(),
      TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(res.error ?? "The delete failed");
  } finally {
    await client.close();
  }
}

/**
 * Reads one file back so it can be edited in place.
 *
 * Content crosses as base64 and is decoded here rather than being
 * interpolated into JSON on the PHP side, so a file containing quotes,
 * newlines or a stray byte sequence cannot break the envelope.
 *
 * Every allowed extension is a text format, so the caller may treat the
 * result as text -- but `isText` reports whether the bytes actually decode
 * as UTF-8, because a file that does not must not be handed to a textarea:
 * saving it back would silently rewrite the undecodable bytes.
 */
export async function readRootFile(
  deps: RootFilesDeps, siteId: string, name: string,
): Promise<{ content: string; bytes: number; isText: boolean }> {
  const nameError = validateRootFileName(name);
  if (nameError) throw new Error(nameError);

  const client = await connect(deps, siteId);
  try {
    const res = await runPhp<{ ok: boolean; b64?: string; bytes?: number; error?: string }>(
      client,
      `
$name = ${phpString(name)};
${PHP_GUARD}
if (!is_file($path)) { return json_encode(array('ok' => false, 'error' => 'That file no longer exists')); }
$size = (int) filesize($path);
if ($size > ${MAX_ROOT_FILE_BYTES}) {
  return json_encode(array('ok' => false, 'error' => 'That file is too large to edit here'));
}
$data = file_get_contents($path);
if ($data === false) { return json_encode(array('ok' => false, 'error' => 'Could not read the file')); }
return json_encode(array('ok' => true, 'b64' => base64_encode($data), 'bytes' => $size));`.trim(),
      TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(res.error ?? "Could not read the file");
    const buf = Buffer.from(res.b64 ?? "", "base64");
    const content = buf.toString("utf8");
    // Round-trips only when every byte was valid UTF-8; a replacement
    // character introduced by decoding will not survive re-encoding.
    const isText = Buffer.from(content, "utf8").equals(buf);
    return { content, bytes: res.bytes ?? buf.byteLength, isText };
  } finally {
    await client.close();
  }
}
