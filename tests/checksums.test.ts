import { describe, it, expect } from "vitest";
import { CHECKSUMS_PHP, runChecksums } from "@/services/security/checksums";
import { MockMcpClient } from "@/lib/mcp/mock";

function client(payload: unknown) {
  return new MockMcpClient({
    handler: () => ({ success: true, data: { success: true, return_value: JSON.stringify(payload) } }),
  });
}

describe("CHECKSUMS_PHP", () => {
  it("fetches the wordpress.org checksums API and skips wp-content", () => {
    expect(CHECKSUMS_PHP).toContain("api.wordpress.org/core/checksums/1.0/");
    expect(CHECKSUMS_PHP).toContain("wp-content/");
    expect(CHECKSUMS_PHP).toContain("md5_file");
    expect(CHECKSUMS_PHP).toContain("return json_encode");
  });
});

describe("runChecksums", () => {
  it("passes on a clean core", async () => {
    const c = await runChecksums(client({ ok: true, checked: 1200, mismatched: [], missing: [] }));
    expect(c).toMatchObject({ check_id: "core_checksums", result: "pass" });
  });
  it("fails on mismatched files", async () => {
    const c = await runChecksums(client({ ok: true, checked: 1200, mismatched: ["wp-includes/x.php"], missing: [] }));
    expect(c.result).toBe("fail");
    expect(c.details?.mismatched).toEqual(["wp-includes/x.php"]);
  });
  it("warns on missing files or API failure", async () => {
    expect((await runChecksums(client({ ok: true, checked: 10, mismatched: [], missing: ["license.txt"] }))).result).toBe("warn");
    expect((await runChecksums(client({ ok: false, error: "no checksums" }))).result).toBe("warn");
  });
});

describe("runChecksums — files WordPress did not ship", () => {
  it("fails on a PHP file in a core directory that is not in the manifest", async () => {
    // The gap an incident on this fleet went through: two shells named to
    // look like core sat beside the real files in wp-includes, and a scan
    // that only compared known files could not see them.
    const c = await runChecksums(client({
      ok: true, checked: 1200, mismatched: [], missing: [],
      unknown: ["wp-includes/class-wp-tax-query-Misc.php", "wp-includes/blocks/post-excerpt-Int32.php"],
    }));
    expect(c.result).toBe("fail");
    expect(c.details?.unknown).toEqual([
      "wp-includes/class-wp-tax-query-Misc.php", "wp-includes/blocks/post-excerpt-Int32.php",
    ]);
  });

  it("still passes when the scanner reports no unknown files", async () => {
    const c = await runChecksums(client({ ok: true, checked: 1200, mismatched: [], missing: [], unknown: [] }));
    expect(c.result).toBe("pass");
  });

  it("only looks for executable files, and only inside wp-admin and wp-includes", () => {
    // A stray .DS_Store is noise; a stray .php is a shell. And wp-content is
    // where everything that is not WordPress legitimately lives.
    expect(CHECKSUMS_PHP).toContain("array('wp-admin', 'wp-includes')");
    expect(CHECKSUMS_PHP).toMatch(/php\|phtml\|phar\|inc/);
    expect(CHECKSUMS_PHP).not.toContain(String.fromCharCode(92));
  });
});
