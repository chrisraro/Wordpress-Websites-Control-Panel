import { describe, it, expect } from "vitest";
import { truncateForLog } from "@/lib/mcp/envelope";

// Finding 8 of the final whole-branch review: LOG_PREVIEW_CHARS (500) is not
// reliably below where admin_users lands in INVENTORY_PHP's response. On a
// stripped install (zero plugins, one theme) the first administrator's
// user_login/user_email land well inside the truncation window. Redacting
// the key outright, rather than relying on the byte offset, is the fix.
describe("truncateForLog", () => {
  // Final whole-branch review, finding 2: wpphp.ts's invalid-JSON branch --
  // the one this module's own header comment names as the path that
  // matters -- calls truncateForLog(env.return_value), and env.return_value
  // is narrowed to a `string` two lines above that call. That call site can
  // never produce an object, so the "stripped install" case must be tested
  // as a string, not the object shape the previous version of this test
  // used (which that path never produces).
  it("redacts admin_users in the raw string wpphp.ts's invalid-JSON branch passes, even when it would otherwise land inside the truncation window", () => {
    // A deliberately tiny envelope shape (no plugins/themes) so admin_users
    // sits near the very start of the stringified payload -- the "stripped
    // install" case the finding describes, well inside LOG_PREVIEW_CHARS --
    // with a malformed tail so this really is the invalid-JSON string the
    // branch under test receives, not parseable JSON.
    const value =
      JSON.stringify({
        wp_version: "6.7",
        php_version: "8.2",
        admin_users: [{ ID: 1, user_login: "root-admin", user_email: "root-admin@example.com" }],
      }) + "TRAILING GARBAGE, NOT VALID JSON";
    const out = truncateForLog(value);
    expect(out).not.toContain("root-admin");
    expect(out).not.toContain("root-admin@example.com");
  });

  it("redacts a scalar admin_users value in a malformed string, dropping to the next top-level separator", () => {
    const value = '{"wp_version":"6.7","admin_users":"root-admin@example.com","php_version"';
    const out = truncateForLog(value);
    expect(out).not.toContain("root-admin@example.com");
  });

  it("redacts through the end of the string when admin_users itself is truncated mid-value", () => {
    // INVENTORY_PHP emits admin_users last, so a response cut off mid-stream
    // is cut off mid-admin_users with no closing bracket at all -- the
    // scan must not leave an unbalanced, half-redacted tail.
    const value = '{"wp_version":"6.7","admin_users":[{"ID":1,"user_login":"root-admin","user_em';
    const out = truncateForLog(value);
    expect(out).not.toContain("root-admin");
  });

  it("does not end the scan early on a bracket inside a quoted admin field", () => {
    const value = JSON.stringify({
      admin_users: [{ user_login: "admin]}", user_email: "weird@example.com" }],
      trailer: "should-survive",
    });
    const out = truncateForLog(value);
    expect(out).not.toContain("weird@example.com");
    expect(out).toContain("should-survive");
  });

  it("redacts admin_users nested inside an array or wrapper object, not only at the top level", () => {
    // Exercises the object-shaped path (redactAdminUsers): unwrapAbility's
    // `r.error ?? result` fallback and wpphp.ts's "unexpected result" branch
    // can both still hold a parsed, nested envelope rather than a string.
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
