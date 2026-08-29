import { describe, it, expect } from "vitest";
import { truncateForLog } from "@/lib/mcp/envelope";

// Finding 8 of the final whole-branch review: LOG_PREVIEW_CHARS (500) is not
// reliably below where admin_users lands in INVENTORY_PHP's response. On a
// stripped install (zero plugins, one theme) the first administrator's
// user_login/user_email land well inside the truncation window. Redacting
// the key outright, rather than relying on the byte offset, is the fix.
describe("truncateForLog", () => {
  it("redacts admin_users even when it would otherwise land inside the truncation window", () => {
    // A deliberately tiny envelope shape (no plugins/themes) so admin_users
    // sits near the very start of the stringified payload -- the "stripped
    // install" case the finding describes, well inside LOG_PREVIEW_CHARS.
    const value = {
      wp_version: "6.7",
      php_version: "8.2",
      admin_users: [{ ID: 1, user_login: "root-admin", user_email: "root-admin@example.com" }],
    };
    const out = truncateForLog(value);
    expect(out).not.toContain("root-admin");
    expect(out).not.toContain("root-admin@example.com");
  });

  it("redacts admin_users nested inside an array or wrapper object, not only at the top level", () => {
    const value = { errors: [{ admin_users: [{ user_login: "nested-admin" }] }] };
    const out = truncateForLog(value);
    expect(out).not.toContain("nested-admin");
  });

  it("still bounds an ordinary long string as a second, independent cap", () => {
    const long = "x".repeat(600);
    const out = truncateForLog(long);
    expect(out.length).toBeLessThan(600);
    expect(out).toContain("…(truncated)");
  });

  it("does not throw on undefined, where JSON.stringify returns the value undefined rather than a string", () => {
    expect(() => truncateForLog(undefined)).not.toThrow();
    expect(typeof truncateForLog(undefined)).toBe("string");
  });
});
