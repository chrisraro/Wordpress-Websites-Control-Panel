import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("server-only", () => ({}));

// buildToolCtx never executes in any other test in the plan: Task 6's own
// test file hand-builds an McpServer and calls register() directly, and
// Task 7 stubs this whole module out. This file is the one place that
// exercises the real function, in particular its `audit` closure, which is
// the single chokepoint every MCP tool's audit trail routes through.

const insertActivityMock = vi.fn(async (_entry: Record<string, unknown>) => {});

vi.mock("@/lib/supabase/server", () => ({
  createServiceSupabase: () => ({}),
}));

vi.mock("@/services/sites/repo", () => ({
  supabaseSitesRepo: () => ({
    insertActivity: (entry: Record<string, unknown>) => insertActivityMock(entry),
  }),
}));

vi.mock("@/services/jobs/repo", () => ({
  supabaseJobsRepo: () => ({}),
}));

vi.mock("@/lib/mcp/client", () => ({
  createSiteMcpClient: () => {
    throw new Error("buildToolCtx must not call the MCP factory itself -- it only wires it through");
  },
}));

import { buildToolCtx } from "@/mcp/context";
import type { TokenAuth } from "@/lib/authz/token";
import type { Viewer } from "@/lib/authz/decide";

function viewer(id: string): Viewer {
  return { id, email: null, role: "admin", permissions: new Set(), grants: new Map() };
}

function auth(): TokenAuth {
  return { viewer: viewer("viewer-1"), tokenId: "tok-real", readOnly: false };
}

describe("buildToolCtx's audit function", () => {
  beforeEach(() => {
    insertActivityMock.mockClear();
  });

  it("records the viewer as the actor", async () => {
    const ctx = buildToolCtx(auth());
    await ctx.audit("site.test_connection", "site-1", {});
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    expect(insertActivityMock.mock.calls[0][0]).toMatchObject({ actor: "viewer-1" });
  });

  it("passes the site id through as site_id when one is given", async () => {
    const ctx = buildToolCtx(auth());
    await ctx.audit("site.test_connection", "site-1", {});
    expect(insertActivityMock.mock.calls[0][0]).toMatchObject({ site_id: "site-1" });
  });

  it("converts a null siteId to undefined, not null -- insertActivity's site_id is string | undefined under strict mode", async () => {
    const ctx = buildToolCtx(auth());
    await ctx.audit("fleet.action", null, {});
    const row = insertActivityMock.mock.calls[0][0] as Record<string, unknown>;
    expect(row.site_id).toBeUndefined();
    expect("site_id" in row).toBe(true);
    expect(row.site_id).not.toBeNull();
  });

  it("passes the action through unchanged", async () => {
    const ctx = buildToolCtx(auth());
    await ctx.audit("site.reconnect", "site-1", {});
    expect(insertActivityMock.mock.calls[0][0]).toMatchObject({ action: "site.reconnect" });
  });

  it("stamps detail.token_id from auth, and a caller-supplied token_id cannot override it", async () => {
    const ctx = buildToolCtx(auth());
    await ctx.audit("site.test_connection", "site-1", { token_id: "[redacted]", note: "x" });
    const row = insertActivityMock.mock.calls[0][0] as { detail: Record<string, unknown> };
    expect(row.detail).toEqual({ note: "x", token_id: "tok-real" });
  });
});
