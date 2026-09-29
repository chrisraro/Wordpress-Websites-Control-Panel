import { describe, expect, it, vi, afterEach } from "vitest";
import {
  checkPublicHost, createGuardedFetch, publicOnlyLookup,
} from "@/lib/net-guard";
import { runHttpHardening } from "@/services/security/hardening";
import { checkSite } from "@/services/security/uptime";
import { discoverMcpEndpoint } from "@/lib/mcp/discover";
import { installVerificationFile } from "@/services/gsc/service";

vi.mock("@/services/rootfiles/service", () => ({
  putRootFile: async () => ({ url: "https://evil.test/googleaaaaaaaaaaaa.html", bytes: 1, sha256: "x", replaced: false }),
  deleteRootFile: async () => {},
}));
// The default resolver answers privately for everything: only the "guarded
// by default" block relies on it; every other test injects its own resolver.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "10.0.0.9", family: 4 }],
  default: { lookup: async () => [{ address: "10.0.0.9", family: 4 }] },
}));

// Security finding (audit 2026-09-29, open 4): the SSRF guard ran only when a
// site record was saved. A name that resolved publicly then and privately
// now (DNS rebinding), or a public site that 302s to 169.254.169.254, still
// steered the panel's outbound requests into private space. The guard now
// runs at connect time, on every redirect hop.

type Addr = { address: string }[];
const table = (map: Record<string, string[]>) =>
  async (host: string): Promise<Addr> => {
    const hit = map[host];
    if (!hit) throw new Error(`ENOTFOUND ${host}`);
    return hit.map((address) => ({ address }));
  };

const resolve = table({
  "site.test": ["93.184.216.34"],
  "other.test": ["93.184.216.35"],
  "rebind.test": ["10.0.0.7"],
});

function recorder(responses: Array<(url: string, init: RequestInit) => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof URL ? input.href : String(input);
    calls.push({ url, init });
    const next = responses[Math.min(i++, responses.length - 1)];
    return next(url, init);
  }) as typeof fetch;
  return { f, calls };
}

const redirect = (to: string, status = 302) => () =>
  new Response(null, { status, headers: { location: to } });
const ok = (body = "ok") => () => new Response(body, { status: 200 });

describe("createGuardedFetch", () => {
  it("refuses a host that now resolves privately, before any request", async () => {
    const { f, calls } = recorder([ok()]);
    const g = createGuardedFetch({ fetchImpl: f, resolve });
    await expect(g("https://rebind.test/")).rejects.toThrow(/private or local network/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a literal private IP without resolving", async () => {
    const { f, calls } = recorder([ok()]);
    const never = async () => { throw new Error("must not resolve"); };
    const g = createGuardedFetch({ fetchImpl: f, resolve: never });
    await expect(g("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/private or local network/);
    expect(calls).toHaveLength(0);
  });

  it("asks for manual redirects and re-validates every hop", async () => {
    const { f, calls } = recorder([redirect("https://other.test/b"), redirect("/c"), ok("done")]);
    const g = createGuardedFetch({ fetchImpl: f, resolve });
    const res = await g("https://site.test/a", { signal: AbortSignal.timeout(1000) });
    expect(await res.text()).toBe("done");
    expect(calls.map((c) => c.url)).toEqual([
      "https://site.test/a", "https://other.test/b", "https://other.test/c",
    ]);
    for (const c of calls) {
      expect(c.init.redirect).toBe("manual");
      expect(c.init.signal).toBeDefined();
    }
  });

  it("refuses a redirect into private space and never fetches it", async () => {
    const { f, calls } = recorder([redirect("http://127.0.0.1:8080/admin"), ok()]);
    const g = createGuardedFetch({ fetchImpl: f, resolve });
    await expect(g("https://site.test/")).rejects.toThrow(/private or local network/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect to a name that resolves privately", async () => {
    const { f, calls } = recorder([redirect("https://rebind.test/"), ok()]);
    const g = createGuardedFetch({ fetchImpl: f, resolve });
    await expect(g("https://site.test/")).rejects.toThrow(/private or local network/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    const { f } = recorder([redirect("file:///etc/passwd"), ok()]);
    const g = createGuardedFetch({ fetchImpl: f, resolve });
    await expect(g("https://site.test/")).rejects.toThrow(/redirect/i);
  });

  it("stops after five redirects", async () => {
    const { f, calls } = recorder([redirect("https://site.test/loop")]);
    const g = createGuardedFetch({ fetchImpl: f, resolve });
    await expect(g("https://site.test/")).rejects.toThrow(/too many redirects/i);
    expect(calls).toHaveLength(6);
  });

  it("returns the redirect itself when redirects are not followed", async () => {
    const { f, calls } = recorder([redirect("https://other.test/")]);
    const g = createGuardedFetch({ fetchImpl: f, resolve, maxRedirects: 0 });
    const res = await g("https://site.test/");
    expect(res.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it("keeps method and body on 307/308 and drops credentials across origins", async () => {
    const { f, calls } = recorder([redirect("https://other.test/mcp", 307), ok()]);
    const g = createGuardedFetch({ fetchImpl: f, resolve });
    await g(new URL("https://site.test/mcp"), {
      method: "POST", body: "{}", headers: { Authorization: "Basic x", "X-Keep": "1" },
    });
    expect(calls[1].init.method).toBe("POST");
    expect(calls[1].init.body).toBe("{}");
    const h = new Headers(calls[1].init.headers);
    expect(h.get("authorization")).toBeNull();
    expect(h.get("x-keep")).toBe("1");
  });

  it("turns a POST into a GET on 303, as fetch does", async () => {
    const { f, calls } = recorder([redirect("https://site.test/next", 303), ok()]);
    const g = createGuardedFetch({ fetchImpl: f, resolve });
    await g("https://site.test/", { method: "POST", body: "{}" });
    expect(calls[1].init.method).toBe("GET");
    expect(calls[1].init.body).toBeUndefined();
  });
});

describe("publicOnlyLookup (connect-time pin against DNS rebinding)", () => {
  const call = (lookup: ReturnType<typeof publicOnlyLookup>, host: string, all: boolean) =>
    new Promise<{ err: Error | null; args: unknown[] }>((done) => {
      lookup(host, { all }, (err: Error | null, ...args: unknown[]) => done({ err, args }));
    });

  it("refuses a name whose answer is private at the moment of connecting", async () => {
    const r = await call(publicOnlyLookup(resolve), "rebind.test", true);
    expect(r.err?.message).toMatch(/private or local network/);
  });

  it("answers in the array shape when asked for all addresses", async () => {
    const r = await call(publicOnlyLookup(resolve), "site.test", true);
    expect(r.err).toBeNull();
    expect(r.args[0]).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("answers in the (address, family) shape otherwise", async () => {
    const r = await call(publicOnlyLookup(resolve), "site.test", false);
    expect(r.err).toBeNull();
    expect(r.args).toEqual(["93.184.216.34", 4]);
  });
});

describe("outbound probes are guarded by default", () => {
  // No fetch injected: the probes must use the guarded fetch, which refuses
  // the private address before the (stubbed) global fetch is ever called.
  const globalFetch = vi.fn(async () => new Response("ok"));

  afterEach(() => { vi.unstubAllGlobals(); globalFetch.mockClear(); });

  it("hardening probes report unreachable instead of fetching", async () => {
    vi.stubGlobal("fetch", globalFetch);
    const checks = await runHttpHardening("https://evil.test");
    expect(globalFetch).not.toHaveBeenCalled();
    expect(checks.every((c) => c.result === "warn")).toBe(true);
  });

  it("uptime check reports down instead of fetching", async () => {
    vi.stubGlobal("fetch", globalFetch);
    const row = await checkSite("http://evil.test");
    expect(globalFetch).not.toHaveBeenCalled();
    expect(row.ok).toBe(false);
  });

  it("MCP discovery refuses with a readable message", async () => {
    vi.stubGlobal("fetch", globalFetch);
    await expect(discoverMcpEndpoint("https://evil.test")).rejects.toThrow(/private or local network/);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("GSC read-back reports unreachable instead of fetching", async () => {
    vi.stubGlobal("fetch", globalFetch);
    const deps = { repo: { getSite: async () => ({ url: "https://evil.test" }) }, mcp: {} } as never;
    const r = await installVerificationFile(deps, "s1", "googleaaaaaaaaaaaa.html");
    expect(globalFetch).not.toHaveBeenCalled();
    expect(r.reachable).toBe(false);
    expect(r.reachError).toMatch(/private or local network/);
  });

  it("checkPublicHost with the default resolver sees the mocked answer", async () => {
    expect((await checkPublicHost("evil.test")).ok).toBe(false);
  });
});
