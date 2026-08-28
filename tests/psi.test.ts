import { describe, it, expect, afterEach } from "vitest";
import { parsePsi, fetchPsi } from "@/lib/adapters/psi";

afterEach(() => { delete process.env.GOOGLE_PSI_API_KEY; });

const RAW = {
  id: "https://example.com/",
  lighthouseResult: {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    categories: {
      performance: { score: 0.72 },
      accessibility: { score: 0.95 },
      "best-practices": { score: 1 },
      seo: { score: 0.9 },
    },
    audits: {
      "largest-contentful-paint": { numericValue: 3120.4 },
      "cumulative-layout-shift": { numericValue: 0.042 },
    },
  },
};

describe("parsePsi", () => {
  it("maps 0-1 category scores to 0-100 and pulls core web vitals", () => {
    const r = parsePsi(RAW, "mobile");
    expect(r).toMatchObject({
      strategy: "mobile", performance: 72, accessibility: 95, bestPractices: 100, seo: 90,
      lcpMs: 3120, clsScore: 0.042, fetchedUrl: "https://example.com/",
    });
  });
  it("returns nulls for missing categories instead of throwing", () => {
    const r = parsePsi({ lighthouseResult: { categories: {}, audits: {} } }, "desktop");
    expect(r).toMatchObject({
      strategy: "desktop", performance: null, accessibility: null,
      bestPractices: null, seo: null, lcpMs: null, clsScore: null,
    });
  });
  it("tolerates a completely unexpected shape", () => {
    expect(parsePsi(null, "mobile").performance).toBeNull();
    expect(parsePsi("nope", "mobile").seo).toBeNull();
  });
});

describe("fetchPsi", () => {
  it("requests all four categories and the given strategy", async () => {
    const fetchImpl = (async (url: unknown) => {
      const u = String(url);
      expect(u).toContain("pagespeedonline/v5/runPagespeed");
      expect(u).toContain("strategy=mobile");
      expect(u).toContain("category=performance");
      expect(u).toContain("category=seo");
      expect(u).toContain("category=accessibility");
      expect(u).toContain("category=best-practices");
      expect(u).not.toContain("key=");
      return new Response(JSON.stringify(RAW), { status: 200 });
    }) as typeof fetch;
    const r = await fetchPsi("https://example.com", "mobile", fetchImpl);
    expect(r.performance).toBe(72);
  });

  it("appends the API key when configured", async () => {
    process.env.GOOGLE_PSI_API_KEY = "k123";
    const fetchImpl = (async (url: unknown) => {
      expect(String(url)).toContain("key=k123");
      return new Response(JSON.stringify(RAW), { status: 200 });
    }) as typeof fetch;
    await fetchPsi("https://example.com", "desktop", fetchImpl);
  });

  it("throws with the status and API message on failure", async () => {
    const body = JSON.stringify({ error: { message: "Quota exceeded" } });
    const fetchImpl = (async () => new Response(body, { status: 429 })) as typeof fetch;
    await expect(fetchPsi("https://example.com", "mobile", fetchImpl))
      .rejects.toThrow(/429.*Quota exceeded/);
  });
});
