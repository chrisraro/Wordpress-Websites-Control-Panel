import type { PsiResult } from "@/lib/adapters/psi";

export type SeoSource =
  | "rankmath_audit" | "rankmath_scores" | "links" | "keywords" | "ai_visibility" | "psi";

export const SEO_SOURCES: SeoSource[] = [
  "rankmath_audit", "rankmath_scores", "links", "keywords", "ai_visibility", "psi",
];

export type SourceStatus = "ok" | "skipped" | "error";

export interface SourceResult<T = unknown> {
  source: SeoSource;
  status: SourceStatus;
  reason?: string;
  data?: T;
}

export interface AuditFinding {
  test_id: string; category: string; status: string; title: string;
  description?: string; fix_text?: string; kb_link?: string;
}
export interface AuditPayload {
  url?: string;
  score: number | null;
  grade?: string;
  statuses?: { ok?: number; fail?: number; warning?: number; info?: number };
  total_tests?: number;
  remote_api_status?: string;
  findings: AuditFinding[];
}
export interface PageScore {
  post_id: number; title: string; keyword: string | null;
  score: number | null; grade: string; label?: string;
}
export interface LinkStats {
  total_internal: number; total_external: number;
  posts_no_internal: number; posts_no_external: number;
}
export interface KeywordRow {
  keyword: string; clicks: number; impressions: number; ctr: number; position: number;
}
export interface KeywordsPayload { connected: boolean; date_range?: string; keywords: KeywordRow[] }
export interface Brand {
  id: string; name: string; url?: string;
  score: number | null; rank: number | null; avg_sentiment: number | null;
  mentions: number | null; citations: number | null;
  analysis_status: string | null; last_analyzed: string | null;
}
export interface AiVisibilityPayload { brands: Brand[] }
export interface PsiPayload { mobile: PsiResult | null; desktop: PsiResult | null; url: string }

export function trendPoints(
  history: Array<{ taken_at: string; payload: unknown }>,
  pick: (payload: unknown) => number | null,
): Array<{ at: string; value: number }> {
  const points: Array<{ at: string; value: number }> = [];
  for (const row of history) {
    const value = pick(row.payload);
    if (value !== null && Number.isFinite(value)) points.push({ at: row.taken_at, value });
  }
  return points;
}
