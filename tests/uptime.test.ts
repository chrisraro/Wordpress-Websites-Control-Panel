import { describe, it, expect } from "vitest";
import { checkSite, frameableFrom } from "@/services/security/uptime";

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

describe("frameability (can the panel show the live homepage in a card?)", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("is frameable with no framing headers", () => {
    expect(frameableFrom(h({}))).toBe(true);
  });

  it("is not frameable with any X-Frame-Options (DENY, SAMEORIGIN — what hardening sends)", () => {
    expect(frameableFrom(h({ "x-frame-options": "SAMEORIGIN" }))).toBe(false);
    expect(frameableFrom(h({ "x-frame-options": "deny" }))).toBe(false);
  });

  it("reads CSP frame-ancestors: '*' or the panel's origin allows, anything else blocks", () => {
    expect(frameableFrom(h({ "content-security-policy": "default-src 'self'; frame-ancestors 'self'" }))).toBe(false);
    expect(frameableFrom(h({ "content-security-policy": "frame-ancestors *" }))).toBe(true);
    expect(frameableFrom(
      h({ "content-security-policy": "frame-ancestors 'self' https://panel.example" }), "https://panel.example",
    )).toBe(true);
    expect(frameableFrom(h({ "content-security-policy": "upgrade-insecure-requests" }))).toBe(true);
  });

  it("checkSite records it, and null when there was no response", async () => {
    const blocked = (async () => new Response("ok", { status: 200, headers: { "x-frame-options": "SAMEORIGIN" } })) as typeof fetch;
    expect((await checkSite("http://site.test", blocked)).frameable).toBe(false);
    const open = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    expect((await checkSite("http://site.test", open)).frameable).toBe(true);
    const down = (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    expect((await checkSite("http://down.test", down)).frameable).toBeNull();
  });
});
