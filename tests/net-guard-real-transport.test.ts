import { describe, it, expect, afterAll, beforeAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { createGuardedFetch } from "@/lib/net-guard";
import { checkSite } from "@/services/security/uptime";

/**
 * Regression: every uptime check, probe and MCP call reported sites down.
 *
 * guardedFetch handed an Agent from the `undici` npm package (v8) to Node's
 * BUILT-IN fetch (which bundles its own, older undici). The two are not
 * compatible: every request threw "fetch failed" / "invalid onRequestStart
 * method", so every site read as unreachable. The unit tests all injected a
 * fetchImpl and never ran the real default pairing -- these do, against a
 * local server, with only name resolution stubbed.
 */
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(301, { location: "/final" }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/plain" }); res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// "site.example" resolves (for the guard) to a public address, while the
// test dispatcher actually connects to the local server.
const publicResolve = async () => [{ address: "93.184.216.34" }];
const toLocal = () => new Agent({
  connect: {
    lookup: ((_h: string, o: { all?: boolean } | undefined, cb: (...a: unknown[]) => void) =>
      o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as never,
  },
});

describe("guarded fetch with its real default transport", () => {
  it("completes a request (the default fetch and dispatcher are compatible)", async () => {
    const f = createGuardedFetch({ resolve: publicResolve, dispatcher: toLocal() });
    const res = await f(`http://site.example:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("follows a redirect hop on the same transport", async () => {
    const f = createGuardedFetch({ resolve: publicResolve, dispatcher: toLocal() });
    const res = await f(`http://site.example:${port}/redirect`);
    expect(res.status).toBe(200);
  });

  it("reports a live site as up through checkSite", async () => {
    const f = createGuardedFetch({ resolve: publicResolve, dispatcher: toLocal() });
    const row = await checkSite(`http://site.example:${port}/`, f);
    expect(row.ok).toBe(true);
    expect(row.http_status).toBe(200);
  });
});
