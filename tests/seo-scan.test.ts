import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { seoScan, type SeoScanDeps } from "@/services/seo/scan";
import type { SeoRepo, SeoSnapshotRow } from "@/services/seo/repo";
import type { SourceResult } from "@/services/seo/types";
import type { SitesRepo } from "@/services/sites/repo";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

const ABILITIES = [
  "rank-math/audit-site-seo", "rank-math/get-seo-scores", "rank-math/get-link-report",
  "rank-math/get-top-keywords", "rank-math/get-ai-visibility-overview",
];

const RM_RESPONSES: Record<string, unknown> = {
  "rank-math/audit-site-seo": { score: 68, grade: "average", findings: [] },
  "rank-math/get-seo-scores": [],
  "rank-math/get-link-report": { stats: { total_internal: 1, total_external: 2, posts_no_internal: 0, posts_no_external: 0 } },
  "rank-math/get-top-keywords": { keywords: [], connected: false },
  "rank-math/get-ai-visibility-overview": { brands: [] },
};

const PSI_RAW = {
  lighthouseResult: {
    finalUrl: "https://site.test/",
    categories: { performance: { score: 0.5 }, seo: { score: 0.9 }, accessibility: { score: 1 }, "best-practices": { score: 1 } },
    audits: { "largest-contentful-paint": { numericValue: 2500 }, "cumulative-layout-shift": { numericValue: 0.01 } },
  },
};

function fakes(opts: { abilities?: string[]; psiFails?: boolean } = {}) {
  const inserted: Array<{ takenAt: string; results: SourceResult[] }> = [];
  let creds = "";
  const client = new MockMcpClient({
    handler: (ability) => ({ success: true, data: RM_RESPONSES[ability] ?? null }),
  });
  const sites = {
    async getSite(id: string) {
      return id === "site-1"
        ? { id, name: "S", url: "https://site.test", mcp_endpoint: "https://site.test/wp-json/mcp/novamira",
            wp_username: "admin", status: "connected", client_label: null,
            capabilities: { abilities: opts.abilities ?? ABILITIES }, created_at: "", updated_at: "" }
        : null;
    },
    async getSiteCredentials() {
      return { mcp_endpoint: "https://site.test/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: creds };
    },
  } as unknown as SitesRepo;
  const seo: SeoRepo = {
    async insertSnapshots(_s, takenAt, results) { inserted.push({ takenAt, results }); },
    async latestBySource() { return {}; },
    async history() { return [] as SeoSnapshotRow[]; },
    async latestAuditScore() { return null; },
    async lastRunAt() { return null; },
  };
  const fetchImpl = (async () => opts.psiFails
    ? new Response("{}", { status: 500 })
    : new Response(JSON.stringify(PSI_RAW), { status: 200 })) as typeof fetch;
  const deps: SeoScanDeps = { sites, seo, mcp: async () => client, fetchImpl };
  return { deps, inserted, client, setCreds: (v: string) => { creds = v; } };
}

describe("seoScan", () => {
  it("stores six sources under one timestamp and closes the client", async () => {
    const f = fakes();
    f.setCreds(await encryptSecret("pass"));
    const res = await seoScan(f.deps, "site-1");
    expect(res.results).toHaveLength(6);
    expect(new Set(res.results.map((r) => r.source)).size).toBe(6);
    expect(f.client.closed).toBe(true);
    expect(f.inserted).toHaveLength(1);
    expect(f.inserted[0].takenAt).toBe(res.takenAt);
    expect(f.inserted[0].results.every((r) => r.status === "ok")).toBe(true);
    const psi = res.results.find((r) => r.source === "psi")!.data as { mobile: { performance: number } | null };
    expect(psi.mobile?.performance).toBe(50);
  });

  it("records a psi error without failing the scan", async () => {
    const f = fakes({ psiFails: true });
    f.setCreds(await encryptSecret("pass"));
    const res = await seoScan(f.deps, "site-1");
    const psi = res.results.find((r) => r.source === "psi")!;
    expect(psi.status).toBe("error");
    expect(res.results.filter((r) => r.status === "ok")).toHaveLength(5);
  });

  it("marks Rank Math sources skipped when the site lacks the abilities", async () => {
    const f = fakes({ abilities: [] });
    f.setCreds(await encryptSecret("pass"));
    const res = await seoScan(f.deps, "site-1");
    expect(res.results.filter((r) => r.status === "skipped")).toHaveLength(5);
    expect(res.results.find((r) => r.source === "psi")!.status).toBe("ok");
  });

  it("throws for an unknown site", async () => {
    const f = fakes();
    await expect(seoScan(f.deps, "nope")).rejects.toThrow(/not found/i);
  });
});
