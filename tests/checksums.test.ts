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
