import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

// Every outbound fetch must carry a timeout. Without one, a hung Google API,
// a site that accepts the connection and never answers, or a stalled 150MB
// Wordfence download holds the request (or the cron worker) until the
// platform kills it -- with no error recorded against the job. Mirrors how
// uptime.ts and psi.ts already pass AbortSignal.timeout.

vi.mock("@/services/rootfiles/service", () => ({
  putRootFile: async () => ({ url: "https://example.com/googleaaaaaaaaaaaa.html", bytes: 53, sha256: "x", replaced: false }),
  deleteRootFile: async () => {},
}));

import { getAccessToken, resetTokenCacheForTests } from "@/lib/google/auth";
import { fetchSearchConsole } from "@/lib/google/searchconsole";
import { fetchGa4Traffic } from "@/lib/google/analytics";
import { discoverMcpEndpoint } from "@/lib/mcp/discover";
import { installVerificationFile } from "@/services/gsc/service";
import { fetchWordfenceFeed } from "@/lib/adapters/vulnfeed/wordfence";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const SA = JSON.stringify({ client_email: "p@x.iam.gserviceaccount.com", private_key: privateKey });

/** A fetch that records each call's URL and signal, answering with `body`. */
function recorder(body: (url: string) => unknown) {
  const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
  const f = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, signal: init?.signal });
    if (u.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    const out = body(u);
    return new Response(typeof out === "string" ? out : JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

let timeoutSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetTokenCacheForTests();
  timeoutSpy = vi.spyOn(AbortSignal, "timeout");
});
afterEach(() => {
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  timeoutSpy.mockRestore();
});

function expectAllSignalled(calls: Array<{ signal: AbortSignal | null | undefined }>) {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) expect(c.signal).toBeInstanceOf(AbortSignal);
}
function timeoutsUsed(): number[] {
  return (timeoutSpy.mock.calls as unknown[][]).map((c) => Number(c[0]));
}

describe("outbound fetch timeouts", () => {
  it("Google token exchange", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA;
    const { f, calls } = recorder(() => ({}));
    await getAccessToken(f);
    expectAllSignalled(calls);
    for (const ms of timeoutsUsed()) expect(ms).toBeGreaterThanOrEqual(15_000);
  });

  it("Search Console queries", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA;
    const { f, calls } = recorder(() => ({ rows: [] }));
    await fetchSearchConsole("sc-domain:x.com", "2026-08-01", "2026-08-31", f);
    expect(calls.filter((c) => c.url.includes("searchAnalytics"))).toHaveLength(3);
    expectAllSignalled(calls);
  });

  it("GA4 runReport", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA;
    const { f, calls } = recorder(() => ({ rows: [] }));
    await fetchGa4Traffic("123", "2026-08-01", "2026-08-31", f);
    expect(calls.some((c) => c.url.includes(":runReport"))).toBe(true);
    expectAllSignalled(calls);
  });

  it("MCP endpoint discovery", async () => {
    const { f, calls } = recorder(() => ({ routes: { "/mcp/novamira": {} } }));
    await discoverMcpEndpoint("https://example.com/", f);
    expectAllSignalled(calls);
  });

  it("GSC verification file read-back", async () => {
    const { f, calls } = recorder(() => "google-site-verification: googleaaaaaaaaaaaa.html");
    const deps = { repo: { getSite: async () => ({ url: "https://example.com" }) }, mcp: {} } as never;
    await installVerificationFile(deps, "s1", "googleaaaaaaaaaaaa.html", f);
    expectAllSignalled(calls);
  });

  it("Wordfence feed download gets a long (120s) budget", async () => {
    const sample = {
      "id-1": {
        id: "id-1", title: "XSS", cvss: { score: 6.1 }, references: [],
        software: [{ type: "plugin", slug: "akismet", affected_versions: { "*": { from_version: "*", to_version: "1.0" } }, patched_versions: ["1.1"] }],
      },
    };
    const { f, calls } = recorder(() => sample);
    await fetchWordfenceFeed("k", f).catch(() => undefined);
    expectAllSignalled(calls);
    expect(timeoutsUsed()).toContain(120_000);
  });
});
