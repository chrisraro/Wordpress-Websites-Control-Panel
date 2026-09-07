import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { resetTokenCacheForTests } from "@/lib/google/auth";
import { fetchSearchConsole, normalizeRows, normalizeTotals } from "@/lib/google/searchconsole";
import {
  fetchGa4Traffic, normalizeTotals as ga4Totals, normalizeChannels,
} from "@/lib/google/analytics";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const SA = JSON.stringify({ client_email: "p@x.iam.gserviceaccount.com", private_key: privateKey });

beforeEach(() => resetTokenCacheForTests());
afterEach(() => { delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON; });

/** Routes the token call and the API calls, recording every request. */
function stub(handler: (url: string, body: unknown) => unknown) {
  const seen: Array<{ url: string; body: unknown }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url: u, body });
    const out = handler(u, body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("Search Console", () => {
  it("returns undefined with no service account, so the source is skipped not failed", async () => {
    const { f } = stub(() => ({}));
    expect(await fetchSearchConsole("sc-domain:x.com", "2026-08-01", "2026-08-31", f)).toBeUndefined();
  });

  it("reads totals from the undimensioned row, not by summing the rows", async () => {
    // Summing is wrong twice over: rows are capped by rowLimit, and one
    // impression counts once per query AND once per page. A site with more
    // than rowLimit queries would have its traffic understated forever.
    const totals = normalizeTotals({ rows: [{ clicks: 900, impressions: 40000, ctr: 0.0225, position: 12.4 }] });
    expect(totals).toEqual({ clicks: 900, impressions: 40000, ctr: 0.0225, position: 12.4 });
  });

  it("keeps the dimension key and drops rows without one", () => {
    const rows = normalizeRows({ rows: [
      { keys: ["el nido tour"], clicks: 12, impressions: 300, ctr: 0.04, position: 8.1 },
      { keys: [], clicks: 1, impressions: 2, ctr: 0.5, position: 1 },
    ] });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("el nido tour");
  });

  it("survives a response with no rows at all", () => {
    // A brand-new property legitimately returns {} -- that is zero traffic,
    // not a malformed response.
    expect(normalizeRows({})).toEqual([]);
    expect(normalizeTotals({})).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 });
  });

  it("encodes the property whole, so sc-domain: and URL prefixes both work", async () => {
    const { f, seen } = stub(() => ({ rows: [] }));
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA;
    await fetchSearchConsole("https://azaleabaguio.com/staging2-baguio/", "2026-08-01", "2026-08-31", f);
    // Unencoded slashes would make the path resolve to a different resource.
    expect(seen[0].url).toContain(encodeURIComponent("https://azaleabaguio.com/staging2-baguio/"));
    expect(seen[0].url).not.toContain("//azaleabaguio.com/staging2-baguio//search");
  });

  it("asks for totals, queries and pages", async () => {
    const { f, seen } = stub(() => ({ rows: [] }));
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA;
    await fetchSearchConsole("sc-domain:x.com", "2026-08-01", "2026-08-31", f);
    const dims = seen.map((s) => (s.body as { dimensions?: string[] })?.dimensions?.[0] ?? "totals");
    expect(dims.sort()).toEqual(["page", "query", "totals"]);
  });

  it("names the likely cause on a 403 rather than leaving a status code", async () => {
    const { f } = stub(() => new Response("forbidden", { status: 403 }));
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA;
    await expect(fetchSearchConsole("sc-domain:x.com", "2026-08-01", "2026-08-31", f))
      .rejects.toThrow(/added as a user on this property/i);
  });
});

describe("GA4", () => {
  it("parses GA4's string metrics into numbers", () => {
    // Every GA4 metric arrives as a string, counts included.
    const t = ga4Totals({ rows: [{ metricValues: [
      { value: "1420" }, { value: "1890" }, { value: "1200" }, { value: "5310" },
    ] }] });
    expect(t).toEqual({ users: 1420, sessions: 1890, engagedSessions: 1200, views: 5310 });
  });

  it("reads channels with their sessions and users", () => {
    const c = normalizeChannels({ rows: [
      { dimensionValues: [{ value: "Organic Search" }], metricValues: [{ value: "900" }, { value: "700" }] },
      { dimensionValues: [{ value: "Direct" }], metricValues: [{ value: "400" }, { value: "380" }] },
    ] });
    expect(c).toEqual([
      { channel: "Organic Search", sessions: 900, users: 700 },
      { channel: "Direct", sessions: 400, users: 380 },
    ]);
  });

  it("labels a missing channel rather than emitting an empty string", () => {
    const c = normalizeChannels({ rows: [{ dimensionValues: [{}], metricValues: [{ value: "5" }, { value: "5" }] }] });
    expect(c[0].channel).toBe("Unassigned");
  });

  it("treats an empty report as zero, not as an error", () => {
    expect(ga4Totals({})).toEqual({ users: 0, sessions: 0, engagedSessions: 0, views: 0 });
    expect(normalizeChannels({})).toEqual([]);
  });

  it("posts to the property id, not a measurement id", async () => {
    const { f, seen } = stub(() => ({ rows: [] }));
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA;
    await fetchGa4Traffic("402551234", "2026-08-01", "2026-08-31", f);
    expect(seen[0].url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/402551234:runReport");
  });

  it("requests metrics in the order the normalizer reads them", async () => {
    // The normalizer reads metricValues positionally because GA4 does not
    // label them in the row; reordering the request silently relabels data.
    const { f, seen } = stub(() => ({ rows: [] }));
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA;
    await fetchGa4Traffic("1", "2026-08-01", "2026-08-31", f);
    const totalsCall = seen.find((s) => !(s.body as { dimensions?: unknown }).dimensions)!;
    expect((totalsCall.body as { metrics: Array<{ name: string }> }).metrics.map((m) => m.name))
      .toEqual(["totalUsers", "sessions", "engagedSessions", "screenPageViews"]);
  });

  it("names the likely cause on a 403", async () => {
    const { f } = stub(() => new Response("nope", { status: 403 }));
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA;
    await expect(fetchGa4Traffic("1", "2026-08-01", "2026-08-31", f))
      .rejects.toThrow(/Viewer on this GA4 property/i);
  });
});
