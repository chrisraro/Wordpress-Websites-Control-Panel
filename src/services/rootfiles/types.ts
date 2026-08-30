/** A static file sitting in a site's document root. */
export interface RootFile {
  name: string;
  bytes: number;
  /** Unix seconds, as PHP's filemtime reports it. */
  modified: number;
  /** Public URL, built from home_url() so subdirectory installs are correct. */
  url: string;
}

/**
 * Extensions this feature will write.
 *
 * Static, inert-to-the-server types only. `.php` is absent and must stay
 * absent: writing PHP into the document root is arbitrary remote code
 * execution on a live client site, which is a different feature with a
 * different risk conversation, not a wider allowlist.
 */
export const ALLOWED_EXTENSIONS = ["html", "htm", "txt", "xml", "json"] as const;

/**
 * Filenames this feature will accept.
 *
 * Must start with an alphanumeric, so a leading dot is impossible and
 * `.htaccess` can never be written. Contains no `/` or `\`, so the name can
 * never escape the document root, and no `..` traversal is expressible.
 *
 * EXACTLY ONE DOT, and it is a security rule, not tidiness. Apache's
 * `mod_mime` historically dispatches on *any* extension segment, and the
 * `AddHandler application/x-httpd-php .php` form still common on shared
 * hosting -- which is what these sites run on -- will execute
 * `shell.php.html` as PHP. A trailing-extension check alone therefore does
 * not make a name inert; forbidding a second dot does. Every real
 * verification file (google<token>.html, BingSiteAuth.xml, ahrefs_<id>.txt)
 * has exactly one dot, so this costs nothing.
 *
 * PHP re-checks the same rule at the far end (see service.ts) rather than
 * trusting that this ran.
 */
export const ROOT_FILE_RE = new RegExp(
  "^[a-zA-Z0-9][a-zA-Z0-9_-]*\\.(" + ALLOWED_EXTENSIONS.join("|") + ")$",
);

/**
 * 64 KB. A search-engine verification file is around 50 bytes and a hand
 * written static page is a few KB, so this is generous for the job while
 * keeping the whole payload inside one base64-encoded PHP snippet.
 */
export const MAX_ROOT_FILE_BYTES = 64 * 1024;

/**
 * WordPress's own root files. Never offered for deletion and never
 * overwritten -- replacing one of these breaks the install rather than
 * changing a static asset.
 */
export const WP_CORE_ROOT_FILES = new Set([
  "index.php", "wp-config.php", "wp-config-sample.php", "wp-settings.php",
  "wp-load.php", "wp-blog-header.php", "wp-cron.php", "wp-login.php",
  "wp-links-opml.php", "wp-mail.php", "wp-signup.php", "wp-trackback.php",
  "wp-activate.php", "wp-comments-post.php", "xmlrpc.php",
  "license.txt", "readme.html", ".htaccess",
]);

/**
 * Files that are writable but carry a consequence worth naming before the
 * click, because getting one wrong harms the client's site rather than the
 * uploader's afternoon.
 *
 * robots.txt is the sharp one: a bad rule here can deindex a client's whole
 * site, and nothing in this panel would report it. It is deliberately
 * allowed rather than blocked -- replacing it is a legitimate thing to want
 * -- but the confirmation escalates and says what is at stake.
 */
export const SENSITIVE_ROOT_FILES = new Set(["robots.txt", "sitemap.xml", "ads.txt"]);

export interface RootFileWriteInput {
  name: string;
  /** Raw bytes, base64-encoded for transport into the PHP snippet. */
  contentBase64: string;
}

export function validateRootFileName(name: string): string | null {
  if (!name) return "Choose a file to upload.";
  if (name !== name.trim()) return "The file name has leading or trailing spaces.";
  if (!ROOT_FILE_RE.test(name)) {
    return `“${name}” isn’t an allowed name. Use letters, numbers, dashes or underscores, then a single dot and ${ALLOWED_EXTENSIONS.join(", ")}.`;
  }
  if (WP_CORE_ROOT_FILES.has(name)) {
    return `“${name}” is a WordPress core file and can’t be replaced from here.`;
  }
  return null;
}
