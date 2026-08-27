import { describe, it, expect } from "vitest";
import { checkSite } from "@/services/security/uptime";

describe("checkSite", () => {
  it("reports ok with timing for a healthy site", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    const row = await checkSite("http://site.test", fetchImpl); // http: skips TLS branch
    expect(row.ok).toBe(true);
    expect(row.http_status).toBe(200);
    expect(row.response_ms).toBeGreaterThanOrEqual(0);
    expect(row.ssl_days_remaining).toBeNull();
  });
  it("reports not-ok for 5xx", async () => {
    const fetchImpl = (async () => new Response("err", { status: 502 })) as typeof fetch;
    const row = await checkSite("http://site.test", fetchImpl);
    expect(row.ok).toBe(false);
    expect(row.http_status).toBe(502);
  });
  it("reports not-ok with null status when unreachable", async () => {
    const fetchImpl = (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    const row = await checkSite("http://down.test", fetchImpl);
    expect(row.ok).toBe(false);
    expect(row.http_status).toBeNull();
  });
});
