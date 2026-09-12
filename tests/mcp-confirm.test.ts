import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import {
  gateConfirm, redactArgs, ok, fail, preview, ENVIRONMENT_NOTE,
  requirePermission, requireWritableToken,
} from "@/mcp/confirm";
import type { TokenAuth } from "@/lib/authz/token";
import type { Viewer } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";

function auth(opts: { readOnly?: boolean; permissions?: AppPermission[] } = {}): TokenAuth {
  return {
    viewer: {
      id: "u1", email: null, role: "admin",
      permissions: new Set(opts.permissions ?? []), grants: new Map(),
    } as Viewer,
    tokenId: opts.readOnly ? "tok-2" : "tok-1",
    readOnly: Boolean(opts.readOnly),
  };
}

const REASON = "Applying the September security patch";

describe("gateConfirm", () => {
  it("returns a preview and does not proceed when confirm is absent", () => {
    const g = gateConfirm(auth(), {}, "Would update 3 plugins", { count: 3 });
    expect(g.proceed).toBe(false);
    if (g.proceed) throw new Error("unreachable");
    expect(g.result.isError).toBeFalsy();
    expect(g.result.content[0].text).toContain("Would update 3 plugins");
  });

  it("returns a preview when confirm is explicitly false", () => {
    expect(gateConfirm(auth(), { confirm: false }, "Would do it", {}).proceed).toBe(false);
  });

  it("errors when confirm is true but no reason is given", () => {
    const g = gateConfirm(auth(), { confirm: true }, "s", {});
    expect(g.proceed).toBe(false);
    if (g.proceed) throw new Error("unreachable");
    expect(g.result.isError).toBe(true);
    expect(g.result.content[0].text).toMatch(/reason is required/i);
  });

  it("errors when the reason is shorter than 10 characters", () => {
    const g = gateConfirm(auth(), { confirm: true, reason: "too short" }, "s", {});
    expect(g.proceed).toBe(false);
    if (g.proceed) throw new Error("unreachable");
    expect(g.result.isError).toBe(true);
  });

  it("proceeds with a valid confirm and reason", () => {
    const g = gateConfirm(auth(), { confirm: true, reason: REASON }, "s", {});
    expect(g.proceed).toBe(true);
    if (!g.proceed) throw new Error("unreachable");
    expect(g.reason).toBe(REASON);
  });

  it("blames the TOKEN, not a permission, when the token is read-only", () => {
    const g = gateConfirm(auth({ readOnly: true }), { confirm: true, reason: REASON }, "s", {});
    expect(g.proceed).toBe(false);
    if (g.proceed) throw new Error("unreachable");
    expect(g.result.isError).toBe(true);
    const text = g.result.content[0].text;
    expect(text).toMatch(/read-only/i);
    expect(text).toMatch(/token/i);
    // A read-only refusal must not be mistaken for a permission problem: the
    // fixes differ (mint a new token vs. be granted a permission).
    expect(text).not.toMatch(/permission/i);
  });

  it("previews rather than erroring for a read-only token that did not confirm", () => {
    const g = gateConfirm(auth({ readOnly: true }), {}, "Would update 3 plugins", {});
    expect(g.proceed).toBe(false);
    if (g.proceed) throw new Error("unreachable");
    expect(g.result.isError).toBeFalsy();
  });
});

describe("requirePermission", () => {
  it("passes when the viewer holds it", () => {
    expect(requirePermission(auth({ permissions: ["wp_toolkit.manage"] }), "wp_toolkit.manage"))
      .toBeNull();
  });

  it("names the missing permission when it does not", () => {
    const r = requirePermission(auth(), "wp_toolkit.manage");
    expect(r?.isError).toBe(true);
    expect(r?.content[0].text).toContain("wp_toolkit.manage");
  });
});

describe("requireWritableToken", () => {
  it("passes a normal token", () => {
    expect(requireWritableToken(auth())).toBeNull();
  });

  it("refuses a read-only token without mentioning permissions", () => {
    const r = requireWritableToken(auth({ readOnly: true }));
    expect(r?.isError).toBe(true);
    expect(r?.content[0].text).toMatch(/read-only/i);
    expect(r?.content[0].text).not.toMatch(/permission/i);
  });
});

describe("redactArgs", () => {
  it("redacts anything that looks like a credential, case-insensitively", () => {
    expect(redactArgs({
      site_id: "s1", app_password: "hunter2", API_KEY: "k", authToken: "t",
      clientSecret: "cs", plugin: "akismet/akismet.php",
    })).toEqual({
      site_id: "s1", app_password: "[redacted]", API_KEY: "[redacted]",
      authToken: "[redacted]", clientSecret: "[redacted]",
      plugin: "akismet/akismet.php",
    });
  });

  it("leaves ordinary values alone", () => {
    expect(redactArgs({ confirm: true, reason: "why" }))
      .toEqual({ confirm: true, reason: "why" });
  });
});

describe("result shapes", () => {
  it("ok serialises the payload as JSON text", () => {
    const r = ok({ a: 1 });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ a: 1 });
  });

  it("fail marks isError", () => {
    expect(fail("nope")).toEqual({
      content: [{ type: "text", text: "nope" }], isError: true,
    });
  });

  it("preview carries the summary, the details and how to confirm", () => {
    const r = preview("Would act on 2 sites", { sites: ["a", "b"] });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("Would act on 2 sites");
    expect(r.content[0].text).toContain("\"sites\"");
    expect(r.content[0].text).toMatch(/confirm/i);
  });

  it("publishes an environment note for tool descriptions", () => {
    expect(ENVIRONMENT_NOTE).toMatch(/staging/i);
    expect(ENVIRONMENT_NOTE).toMatch(/production/i);
  });
});
