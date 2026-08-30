import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateRootFileName, ROOT_FILE_RE, ALLOWED_EXTENSIONS,
  WP_CORE_ROOT_FILES, MAX_ROOT_FILE_BYTES,
} from "@/services/rootfiles/types";
import { environmentSuffix } from "@/app/(dashboard)/sites/[id]/site-heading";

/**
 * This name is the only thing between an operator-supplied string and a write
 * into a live client site's document root, so the negative cases matter more
 * than the positive ones.
 */
describe("validateRootFileName", () => {
  it("accepts the shape a search engine actually asks for", () => {
    expect(validateRootFileName("google5addd854d9cd9c88.html")).toBeNull();
    expect(validateRootFileName("BingSiteAuth.xml")).toBeNull();
    expect(validateRootFileName("ahrefs_1234.txt")).toBeNull();
  });

  it.each([
    ["../wp-config.php", "parent traversal"],
    ["../../etc/passwd", "deep traversal"],
    ["wp-content/index.html", "a subdirectory"],
    ["wp-content\\index.html", "a Windows separator"],
    ["/etc/hosts", "an absolute path"],
    [".htaccess", "a leading dot"],
    [".env", "a dotfile"],
    ["shell.php", "PHP"],
    ["shell.PHP", "PHP in a different case"],
    // Apache's `AddHandler ... .php` form, still common on the shared hosting
    // these sites run on, dispatches on ANY extension segment -- so a
    // trailing-extension check alone would let these execute as PHP. The
    // first draft of this feature accepted every one of them.
    ["shell.php.html", "PHP in a non-final extension segment"],
    ["shell.phtml.txt", "phtml in a non-final segment"],
    ["x.php5.html", "a versioned PHP extension mid-name"],
    ["a.b.html", "any second dot at all"],
    ["sitemap.xml.gz", "a stacked extension"],
    ["evil.html.php", "a double extension ending in PHP"],
    ["", "an empty name"],
    ["   ", "whitespace"],
    ["file.html ", "a trailing space"],
    [" file.html", "a leading space"],
    ["nodotextension", "no extension"],
    ["archive.zip", "a disallowed extension"],
  ])("rejects %j — %s", (name) => {
    expect(validateRootFileName(name)).not.toBeNull();
  });

  it("refuses to overwrite WordPress core files", () => {
    // index.php and wp-config.php are already excluded by the extension rule;
    // these two are not, which is exactly why the blocklist exists as well.
    expect(validateRootFileName("readme.html")).not.toBeNull();
    expect(validateRootFileName("license.txt")).not.toBeNull();
    for (const f of WP_CORE_ROOT_FILES) {
      expect(validateRootFileName(f), `${f} must be refused`).not.toBeNull();
    }
  });

  it("never admits a name containing a path separator", () => {
    // Property-style check over the regex itself, so a future edit that
    // loosens it fails here rather than in production.
    for (const bad of ["/", "\\", "..", "\0"]) {
      expect(ROOT_FILE_RE.test(`a${bad}b.html`)).toBe(false);
    }
  });

  it("does not allow php in the extension allowlist", () => {
    // The single most important line in this feature.
    expect(ALLOWED_EXTENSIONS as readonly string[]).not.toContain("php");
    expect(ALLOWED_EXTENSIONS as readonly string[]).not.toContain("phtml");
  });
});

describe("the PHP side re-checks what TypeScript already checked", () => {
  // The TS guard runs on a different machine from the write. If a future
  // refactor drops it, the far side must still refuse -- so pin that the
  // generated PHP carries its own name check, core-file blocklist and
  // realpath containment rather than trusting the caller.
  const SRC = readFileSync(
    join(process.cwd(), "src", "services", "rootfiles", "service.ts"),
    "utf8",
  );

  it.each([
    ["basename equality", "basename($name)"],
    ["a name pattern", "preg_match"],
    ["a core-file blocklist", "WordPress core file"],
    ["realpath containment", "realpath(dirname($path)) !== realpath(ABSPATH)"],
  ])("the PHP guard still performs %s", (_label, needle) => {
    expect(SRC).toContain(needle);
  });

  it("reads the file back after writing instead of trusting the write", () => {
    // A write that reports success and a file that is correct on disk are
    // different claims; this project has been bitten by the difference.
    expect(SRC).toContain("hash_file('sha256', $path)");
    expect(SRC).toContain("clearstatcache");
  });

  it("never interpolates an untrusted value straight into PHP", () => {
    // Every dynamic value must travel through phpString(), which base64s it.
    // A bare `${name}` inside a PHP template literal would be an injection.
    expect(SRC).not.toMatch(/\$\{name\}/);
    expect(SRC).toContain("phpString(name)");
  });
});

describe("size limit", () => {
  it("is small enough to stay inside one PHP snippet", () => {
    // The payload is base64-encoded into the snippet, which inflates it by
    // about a third; 64 KB keeps the generated code well under any sane
    // request limit while being far more than a verification file needs.
    expect(MAX_ROOT_FILE_BYTES).toBe(64 * 1024);
    expect(Math.ceil((MAX_ROOT_FILE_BYTES * 4) / 3)).toBeLessThan(100 * 1024);
  });
});

describe("environmentSuffix", () => {
  it("does not repeat what the site name already says", () => {
    // All four staging sites are named "... (Staging)" today, so without this
    // every confirmation read "Azalea Baguio (Staging) (STAGING)?". A label
    // people read twice is one they stop reading.
    expect(environmentSuffix({
      name: "Azalea Baguio (Staging)", url: "https://azaleabaguio.com/staging2-baguio",
      client_label: null, environment: "staging",
    })).toBe("");
  });

  it("still marks a staging site whose name gives nothing away", () => {
    // The case isStaging() cannot see either: a staging copy in a
    // subdirectory of another client's domain, named like production.
    expect(environmentSuffix({
      name: "Cherry Bus", url: "https://onlinecreativesolutions.com/cherrybus",
      client_label: null, environment: "staging",
    })).toBe(" (STAGING)");
  });

  it("never labels anything production", () => {
    // isStaging() is one-directional: false means "not identified", never
    // "confirmed production", so there is no PRODUCTION suffix to render.
    expect(environmentSuffix({
      name: "Aral Abroad", url: "https://aralabroad.com",
      client_label: null, environment: "production",
    })).toBe("");
  });
});
