import { describe, it, expect } from "vitest";
import { collectRankMath, RANKMATH_ABILITIES } from "@/services/seo/collect";
import { MockMcpClient } from "@/lib/mcp/mock";
import type { AuditPayload, KeywordsPayload, PageScore } from "@/services/seo/types";

const ALL = Object.values(RANKMATH_ABILITIES);

// Shapes copied from live probes of a production site (2026-08-28).
const RESPONSES: Record<string, unknown> = {
  "rank-math/audit-site-seo": {
    url: "https://site.test", score: 68, grade: "average",
    statuses: { ok: 20, fail: 3, warning: 5, info: 2 }, total_tests: 30,
    remote_api_status: "ok",
    findings: [
      { test_id: "title_length", category: "basic", status: "fail", title: "Title too long",
        description: "d", fix_text: "Shorten it", kb_link: "https://rankmath.com/kb/x" },
    ],
  },
  "rank-math/get-seo-scores": [
    { post_id: 3843, title: "How to Buy Property", keyword: "buy property", score: 57, grade: "ok", label: "OK", last_updated: 1787807148 },
    { post_id: 3841, title: "Permits", keyword: "permits", score: 15, grade: "bad", label: "Needs improvement", last_updated: 1787806307 },
  ],
  "rank-math/get-link-report": {
    stats: { total_internal: 120, total_external: 45, posts_no_internal: 3, posts_no_external: 9 },
    audit: null, upgrade: { message: "Upgrade", url: "https://rankmath.com/pricing" },
  },
  "rank-math/get-top-keywords": {
    keywords: [{ keyword: "el nido", clicks: 120, impressions: 4000, ctr: 3, position: 8.4 }],
    date_range: "last_30_days", connected: true,
  },
  "rank-math/get-ai-visibility-overview": { summary: [], brands: [] },
};

describe("collectRankMath", () => {
  function build(overrides: Record<string, unknown> = {}, failing: string[] = []) {
    const table = { ...RESPONSES, ...overrides };
    return new MockMcpClient({
      handler: (abilityName) => {
        if (failing.includes(abilityName)) throw new Error(`boom: ${abilityName}`);
        if (!(abilityName in table)) throw new Error(`unexpected ability ${abilityName}`);
        // Abilities come back wrapped in the adapter envelope.
        return { success: true, data: table[abilityName] };
      },
    });
  }

  it("collects all five sources with normalized payloads", async () => {
    const results = await collectRankMath(build(), ALL);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === "ok")).toBe(true);

    const audit = results.find((r) => r.source === "rankmath_audit")!.data as AuditPayload;
    expect(audit.score).toBe(68);
    expect(audit.findings[0].test_id).toBe("title_length");

    const scores = results.find((r) => r.source === "rankmath_scores")!.data as { pages: PageScore[] };
    expect(scores.pages).toHaveLength(2);
    expect(scores.pages[1]).toMatchObject({ post_id: 3841, grade: "bad" });

    const links = results.find((r) => r.source === "links")!.data as { stats: { total_internal: number } };
    expect(links.stats.total_internal).toBe(120);

    const kw = results.find((r) => r.source === "keywords")!.data as KeywordsPayload;
    expect(kw.connected).toBe(true);
    expect(kw.keywords[0].keyword).toBe("el nido");

    const aeo = results.find((r) => r.source === "ai_visibility")!.data as { brands: unknown[] };
    expect(aeo.brands).toEqual([]);
  });

  it("skips sources whose ability the site lacks", async () => {
    const results = await collectRankMath(build(), ["rank-math/audit-site-seo"]);
    const audit = results.find((r) => r.source === "rankmath_audit")!;
    const kw = results.find((r) => r.source === "keywords")!;
    expect(audit.status).toBe("ok");
    expect(kw.status).toBe("skipped");
    expect(kw.reason).toMatch(/not available/i);
  });

  it("records per-source errors without failing the others", async () => {
    const results = await collectRankMath(build({}, ["rank-math/get-link-report"]), ALL);
    const links = results.find((r) => r.source === "links")!;
    expect(links.status).toBe("error");
    expect(links.reason).toMatch(/boom/);
    expect(results.filter((r) => r.status === "ok")).toHaveLength(4);
  });

  it("tolerates unexpected payload shapes", async () => {
    const results = await collectRankMath(
      build({ "rank-math/get-seo-scores": { not: "an array" }, "rank-math/audit-site-seo": null }), ALL,
    );
    const scores = results.find((r) => r.source === "rankmath_scores")!.data as { pages: PageScore[] };
    expect(scores.pages).toEqual([]);
    const audit = results.find((r) => r.source === "rankmath_audit")!.data as AuditPayload;
    expect(audit.score).toBeNull();
    expect(audit.findings).toEqual([]);
  });
});
