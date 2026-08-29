import { describe, it, expect, vi } from "vitest";
import { unwrapAbility } from "@/lib/mcp/envelope";
import { runPhp, phpString } from "@/lib/wpphp";
import { MockMcpClient } from "@/lib/mcp/mock";
import { McpToolError } from "@/lib/mcp/errors";

describe("unwrapAbility", () => {
  it("unwraps the {success, data} envelope", () => {
    expect(unwrapAbility({ success: true, data: { a: 1 } })).toEqual({ a: 1 });
  });
  it("throws McpToolError on {success:false}", () => {
    expect(() => unwrapAbility({ success: false, error: "nope" })).toThrow(McpToolError);
    expect(() => unwrapAbility({ success: false, error: "nope" })).toThrow("nope");
  });
  it("does not serialise a non-string error (or the envelope) into the thrown message", () => {
    const sensitive = { admin_users: [{ user_login: "root-admin" }] };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => unwrapAbility({ success: false, error: sensitive })).toThrow(McpToolError);
      expect(() => unwrapAbility({ success: false, error: sensitive })).not.toThrow(/root-admin/);
    } finally {
      spy.mockRestore();
    }
  });
  it("passes through unwrapped results", () => {
    expect(unwrapAbility({ abilities: [] })).toEqual({ abilities: [] });
    expect(unwrapAbility("plain")).toBe("plain");
  });
});

describe("phpString", () => {
  it("embeds values as base64 with no raw characters", () => {
    const out = phpString("akismet/akismet.php'; rm -rf /");
    expect(out).toMatch(/^base64_decode\('[A-Za-z0-9+/=]+'\)$/);
    expect(out).not.toContain("rm -rf");
    expect(Buffer.from(out.slice(15, -2), "base64").toString("utf8")).toBe("akismet/akismet.php'; rm -rf /");
  });
});

describe("runPhp", () => {
  it("executes novamira/execute-php and decodes the returned JSON", async () => {
    const mock = new MockMcpClient({
      handler: (name, args) => {
        expect(name).toBe("novamira/execute-php");
        expect(String((args as { code: string }).code)).toContain("return json_encode");
        return { success: true, data: { success: true, return_value: '{"x":42}', output: "", errors: [] } };
      },
    });
    expect(await runPhp(mock, "return json_encode(['x' => 42]);")).toEqual({ x: 42 });
  });

  it("throws McpToolError when the PHP run reports failure", async () => {
    const mock = new MockMcpClient({
      handler: () => ({ success: true, data: { success: false, errors: [{ message: "boom" }] } }),
    });
    await expect(runPhp(mock, "return 1;")).rejects.toThrow(/PHP execution failed/);
  });

  it("throws when the snippet returns no JSON string", async () => {
    const mock = new MockMcpClient({
      handler: () => ({ success: true, data: { success: true, return_value: null } }),
    });
    await expect(runPhp(mock, "return 1;")).rejects.toThrow(/did not return a JSON string/);
  });

  it("throws McpToolError when the adapter envelope reports failure", async () => {
    const mock = new MockMcpClient({ handler: () => ({ success: false, error: "ability blew up" }) });
    await expect(runPhp(mock, "return 1;")).rejects.toThrow("ability blew up");
  });

  it("never lets a non-string adapter error embed response content in the thrown message", async () => {
    // unwrapAbility is called before runPhp's own hardening ever sees the
    // result -- a non-string r.error means the fallback branch would
    // otherwise JSON.stringify the whole envelope, including admin_users and
    // other site-sensitive data, into a message manage-actions.ts returns
    // verbatim to any client holding a `manage` grant.
    const sensitive = { admin_users: [{ user_login: "root-admin", user_email: "root@example.com" }] };
    const mock = new MockMcpClient({ handler: () => ({ success: false, error: sensitive }) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runPhp(mock, "return 1;")).rejects.toThrow(McpToolError);
      await expect(runPhp(mock, "return 1;")).rejects.not.toThrow(/root-admin|root@example\.com/);
    } finally {
      spy.mockRestore();
    }
  });
});
