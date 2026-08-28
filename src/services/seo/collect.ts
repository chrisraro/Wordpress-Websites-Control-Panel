import type { SiteMcpClient } from "@/lib/mcp/client";
import { unwrapAbility } from "@/lib/mcp/envelope";
import type {
  AiVisibilityPayload, AuditFinding, AuditPayload, Brand, KeywordRow,
  KeywordsPayload, LinkStats, PageScore, SeoSource, SourceResult,
} from "./types";

const SEO_TIMEOUT_MS = 120_000;

export const RANKMATH_ABILITIES = {
  rankmath_audit: "rank-math/audit-site-seo",
  rankmath_scores: "rank-math/get-seo-scores",
  links: "rank-math/get-link-report",
  keywords: "rank-math/get-top-keywords",
  ai_visibility: "rank-math/get-ai-visibility-overview",
} as const;

const ARGS: Record<string, Record<string, unknown>> = {
  "rank-math/audit-site-seo": {},
  "rank-math/get-seo-scores": { number_of_posts: 25 },
  "rank-math/get-link-report": {},
  "rank-math/get-top-keywords": { date_range: "last_30_days", limit: 25 },
  "rank-math/get-ai-visibility-overview": {},
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function normalizeAudit(raw: unknown): AuditPayload {
  const r = obj(raw);
  const findings = Array.isArray(r.findings) ? r.findings : [];
  return {
    url: typeof r.url === "string" ? r.url : undefined,
    score: numOrNull(r.score),
    grade: typeof r.grade === "string" ? r.grade : undefined,
    statuses: obj(r.statuses) as AuditPayload["statuses"],
    total_tests: numOrNull(r.total_tests) ?? undefined,
    remote_api_status: typeof r.remote_api_status === "string" ? r.remote_api_status : undefined,
    findings: findings.map((f): AuditFinding => {
      const x = obj(f);
      return {
        test_id: str(x.test_id, "unknown"),
        category: str(x.category, "basic"),
        status: str(x.status, "info"),
        title: str(x.title, str(x.test_id, "Finding")),
        description: typeof x.description === "string" ? x.description : undefined,
        fix_text: typeof x.fix_text === "string" ? x.fix_text : undefined,
        // Remote data becomes an href in the UI — only http(s) may through.
        kb_link: typeof x.kb_link === "string" && /^https?:\/\//i.test(x.kb_link)
          ? x.kb_link : undefined,
      };
    }),
  };
}

function normalizeScores(raw: unknown): { pages: PageScore[] } {
  const list = Array.isArray(raw) ? raw : [];
  return {
    pages: list.map((p): PageScore => {
      const x = obj(p);
      return {
        post_id: numOrNull(x.post_id) ?? 0,
        title: str(x.title, "(untitled)"),
        keyword: typeof x.keyword === "string" ? x.keyword : null,
        score: numOrNull(x.score),
        grade: str(x.grade, "na"),
        label: typeof x.label === "string" ? x.label : undefined,
      };
    }),
  };
}

function normalizeLinks(raw: unknown): { stats: LinkStats; upgrade: string | null } {
  const r = obj(raw);
  const s = obj(r.stats);
  return {
    stats: {
      total_internal: numOrNull(s.total_internal) ?? 0,
      total_external: numOrNull(s.total_external) ?? 0,
      posts_no_internal: numOrNull(s.posts_no_internal) ?? 0,
      posts_no_external: numOrNull(s.posts_no_external) ?? 0,
    },
    upgrade: typeof obj(r.upgrade).message === "string" ? String(obj(r.upgrade).message) : null,
  };
}

function normalizeKeywords(raw: unknown): KeywordsPayload {
  const r = obj(raw);
  const list = Array.isArray(r.keywords) ? r.keywords : [];
  return {
    connected: r.connected === true,
    date_range: typeof r.date_range === "string" ? r.date_range : undefined,
    keywords: list.map((k): KeywordRow => {
      const x = obj(k);
      return {
        keyword: str(x.keyword, "(unknown)"),
        clicks: numOrNull(x.clicks) ?? 0,
        impressions: numOrNull(x.impressions) ?? 0,
        ctr: numOrNull(x.ctr) ?? 0,
        position: numOrNull(x.position) ?? 0,
      };
    }),
  };
}

function normalizeAiVisibility(raw: unknown): AiVisibilityPayload {
  const r = obj(raw);
  const list = Array.isArray(r.brands) ? r.brands : [];
  return {
    brands: list.map((b): Brand => {
      const x = obj(b);
      return {
        id: str(x.id, ""),
        name: str(x.name, "(unnamed brand)"),
        url: typeof x.url === "string" ? x.url : undefined,
        score: numOrNull(x.score),
        rank: numOrNull(x.rank),
        avg_sentiment: numOrNull(x.avg_sentiment),
        mentions: numOrNull(x.mentions),
        citations: numOrNull(x.citations),
        analysis_status: typeof x.analysis_status === "string" ? x.analysis_status : null,
        last_analyzed: typeof x.last_analyzed === "string" ? x.last_analyzed : null,
      };
    }),
  };
}

const NORMALIZERS: Record<string, (raw: unknown) => unknown> = {
  "rank-math/audit-site-seo": normalizeAudit,
  "rank-math/get-seo-scores": normalizeScores,
  "rank-math/get-link-report": normalizeLinks,
  "rank-math/get-top-keywords": normalizeKeywords,
  "rank-math/get-ai-visibility-overview": normalizeAiVisibility,
};

export async function collectRankMath(
  client: SiteMcpClient, abilities: string[],
): Promise<SourceResult[]> {
  const available = new Set(abilities);
  const results: SourceResult[] = [];
  for (const [source, ability] of Object.entries(RANKMATH_ABILITIES) as Array<[SeoSource, string]>) {
    if (!available.has(ability)) {
      results.push({
        source, status: "skipped",
        reason: `Ability not available on this site (${ability})`,
      });
      continue;
    }
    try {
      const raw = await client.executeAbility(ability, ARGS[ability], { timeoutMs: SEO_TIMEOUT_MS });
      results.push({ source, status: "ok", data: NORMALIZERS[ability](unwrapAbility(raw)) });
    } catch (e) {
      results.push({ source, status: "error", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
