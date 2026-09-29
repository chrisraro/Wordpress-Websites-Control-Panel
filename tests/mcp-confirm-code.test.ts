import { describe, it, expect, vi, beforeAll } from "vitest";
vi.mock("server-only", () => ({}));

import { gateConfirm, mintConfirmCode, CONFIRM_CODE_TTL_MS } from "@/mcp/confirm";
import type { TokenAuth } from "@/lib/authz/token";
import type { Viewer } from "@/lib/authz/decide";

// Security finding (audit 2026-09-29, open 5): `confirm: true` + `reason`
// were supplied by the same model that reads site-controlled text (plugin
// names, error strings), so a hostile site could steer it into a destructive
// call in one step. The real call now needs a code only the dry run hands
// out, bound to the token, the user, the tool and the exact arguments.

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
});

function auth(userId = "u1", tokenId = "tok-1"): TokenAuth {
  return {
    viewer: { id: userId, email: null, role: "admin", permissions: new Set(), grants: new Map() } as Viewer,
    tokenId,
    readOnly: false,
  };
}

const REASON = "Removing an abandoned plugin per ticket 42";
const SITE = "1b6e3d4f-5c7e-4a92-8d3b-6f4c2a9e7b51";
const ARGS = { site_id: SITE, plugin_file: "akismet/akismet.php" };

function codeFrom(text: string): string {
  const m = /confirm_code: "([^"]+)"/.exec(text);
  if (!m) throw new Error(`no confirm_code in preview:\n${text}`);
  return m[1];
}

function dryRun(a: TokenAuth, tool: string, args: Record<string, unknown>) {
  const g = gateConfirm(a, tool, args, "Would delete it", { args });
  if (g.proceed) throw new Error("dry run proceeded");
  return codeFrom(g.result.content[0].text);
}

describe("confirm codes", () => {
  it("the dry run hands out a code and the matching real call proceeds", () => {
    const code = dryRun(auth(), "delete_plugin", ARGS);
    const g = gateConfirm(auth(), "delete_plugin", { ...ARGS, confirm: true, reason: REASON, confirm_code: code }, "s", {});
    expect(g.proceed).toBe(true);
  });

  it("refuses confirm: true without a code, and says how to get one", () => {
    const g = gateConfirm(auth(), "delete_plugin", { ...ARGS, confirm: true, reason: REASON }, "s", {});
    expect(g.proceed).toBe(false);
    if (g.proceed) return;
    expect(g.result.isError).toBe(true);
    expect(g.result.content[0].text).toMatch(/confirm_code/);
    expect(g.result.content[0].text).toMatch(/without confirm/i);
  });

  it("refuses a code minted for different arguments", () => {
    const code = dryRun(auth(), "delete_plugin", ARGS);
    const g = gateConfirm(auth(), "delete_plugin",
      { ...ARGS, plugin_file: "wordfence/wordfence.php", confirm: true, reason: REASON, confirm_code: code }, "s", {});
    expect(g.proceed).toBe(false);
  });

  it("refuses a code minted for a different site", () => {
    const code = dryRun(auth(), "delete_plugin", ARGS);
    const g = gateConfirm(auth(), "delete_plugin",
      { ...ARGS, site_id: "2c7f4e5a-6d8f-4b03-9e4c-7a5d3b1f8c62", confirm: true, reason: REASON, confirm_code: code }, "s", {});
    expect(g.proceed).toBe(false);
  });

  it("refuses a code minted for a different tool", () => {
    const code = dryRun(auth(), "deactivate_plugin", ARGS);
    const g = gateConfirm(auth(), "delete_plugin", { ...ARGS, confirm: true, reason: REASON, confirm_code: code }, "s", {});
    expect(g.proceed).toBe(false);
  });

  it("refuses a code minted for another token or another user", () => {
    const code = dryRun(auth("u1", "tok-1"), "delete_plugin", ARGS);
    for (const other of [auth("u1", "tok-2"), auth("u2", "tok-1")]) {
      const g = gateConfirm(other, "delete_plugin", { ...ARGS, confirm: true, reason: REASON, confirm_code: code }, "s", {});
      expect(g.proceed).toBe(false);
    }
  });

  it("refuses an expired code", () => {
    const minted = Date.now() - CONFIRM_CODE_TTL_MS - 1000;
    const code = mintConfirmCode(auth(), "delete_plugin", ARGS, minted);
    const g = gateConfirm(auth(), "delete_plugin", { ...ARGS, confirm: true, reason: REASON, confirm_code: code }, "s", {});
    expect(g.proceed).toBe(false);
    if (g.proceed) return;
    expect(g.result.content[0].text).toMatch(/expired|does not match/i);
  });

  it("refuses a forged code with a far-future expiry", () => {
    const real = dryRun(auth(), "delete_plugin", ARGS);
    const forged = `${Math.floor(Date.now() / 1000) + 10 * 365 * 86400}.${real.split(".")[1]}`;
    const g = gateConfirm(auth(), "delete_plugin", { ...ARGS, confirm: true, reason: REASON, confirm_code: forged }, "s", {});
    expect(g.proceed).toBe(false);
  });

  it("refuses garbage without throwing", () => {
    for (const bad of ["", "x", "1.2.3", "abc.def", "9".repeat(40)]) {
      const g = gateConfirm(auth(), "delete_plugin", { ...ARGS, confirm: true, reason: REASON, confirm_code: bad }, "s", {});
      expect(g.proceed).toBe(false);
    }
  });

  it("binds canonical arguments: key order does not matter", () => {
    const code = dryRun(auth(), "delete_plugin", { plugin_file: ARGS.plugin_file, site_id: SITE });
    const g = gateConfirm(auth(), "delete_plugin", { ...ARGS, confirm: true, reason: REASON, confirm_code: code }, "s", {});
    expect(g.proceed).toBe(true);
  });

  it("still requires a reason even with a valid code", () => {
    const code = dryRun(auth(), "delete_plugin", ARGS);
    const g = gateConfirm(auth(), "delete_plugin", { ...ARGS, confirm: true, confirm_code: code }, "s", {});
    expect(g.proceed).toBe(false);
    if (g.proceed) return;
    expect(g.result.content[0].text).toMatch(/reason is required/i);
  });
});
