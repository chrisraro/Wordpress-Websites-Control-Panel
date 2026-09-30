import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy as middleware } from "@/proxy";

/**
 * Routes that authenticate themselves must pass through middleware without a
 * Supabase session cookie. The route tests call handlers directly, so a
 * middleware redirect in front of them is invisible there — this test runs
 * the request through middleware itself.
 */
function anonymous(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(new URL(path, "https://panel.test"), init);
}

function isLoginRedirect(res: Response) {
  return res.status >= 300 && res.status < 400
    && (res.headers.get("location") ?? "").endsWith("/login");
}

describe("middleware lets self-authenticating routes through", () => {
  it("does not redirect a bearer-token MCP request to /login", async () => {
    const res = await middleware(anonymous("/api/mcp", {
      method: "POST",
      headers: { authorization: "Bearer wpcp_test", "content-type": "application/json" },
    }));
    expect(isLoginRedirect(res)).toBe(false);
  });

  it.each(["/api/cron/process", "/api/webhooks/n8n/geogrid", "/r/abc"])(
    "does not redirect %s", async (path) => {
      const res = await middleware(anonymous(path));
      expect(isLoginRedirect(res)).toBe(false);
    },
  );
});
