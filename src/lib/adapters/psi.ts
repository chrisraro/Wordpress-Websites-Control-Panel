import { getOptionalEnv } from "@/lib/env";

export interface PsiResult {
  strategy: "mobile" | "desktop";
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  lcpMs: number | null;
  clsScore: number | null;
  fetchedUrl: string | null;
}

const API = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

function pct(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function num(v: unknown, digits = 0): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function parsePsi(raw: unknown, strategy: "mobile" | "desktop"): PsiResult {
  const lr = (raw && typeof raw === "object"
    ? (raw as { lighthouseResult?: Record<string, unknown> }).lighthouseResult
    : undefined) ?? {};
  const cats = (lr.categories ?? {}) as Record<string, { score?: unknown }>;
  const audits = (lr.audits ?? {}) as Record<string, { numericValue?: unknown }>;
  return {
    strategy,
    performance: pct(cats.performance?.score),
    accessibility: pct(cats.accessibility?.score),
    bestPractices: pct(cats["best-practices"]?.score),
    seo: pct(cats.seo?.score),
    lcpMs: num(audits["largest-contentful-paint"]?.numericValue),
    clsScore: num(audits["cumulative-layout-shift"]?.numericValue, 3),
    fetchedUrl: typeof lr.finalUrl === "string" ? lr.finalUrl : null,
  };
}

export async function fetchPsi(
  url: string, strategy: "mobile" | "desktop", fetchImpl: typeof fetch = fetch,
): Promise<PsiResult> {
  const params = new URLSearchParams();
  params.set("url", url);
  params.set("strategy", strategy);
  for (const c of ["performance", "accessibility", "best-practices", "seo"]) {
    params.append("category", c);
  }
  const key = getOptionalEnv("GOOGLE_PSI_API_KEY");
  if (key) params.set("key", key);

  const res = await fetchImpl(`${API}?${params.toString()}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ? `: ${body.error.message}` : "";
    } catch { /* body not JSON */ }
    throw new Error(`PageSpeed Insights failed: HTTP ${res.status}${detail}`);
  }
  return parsePsi(await res.json(), strategy);
}
