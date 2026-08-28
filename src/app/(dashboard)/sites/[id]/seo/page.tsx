import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { trendPoints } from "@/services/seo/types";
import type {
  AiVisibilityPayload, AuditPayload, KeywordsPayload, LinkStats, PageScore, PsiPayload,
} from "@/services/seo/types";
import { SiteTabs } from "../tabs";
import { ManageForm, type ManageFormAction } from "../action-form";
import { runSeoScanAction } from "../seo-actions";
import { Sparkline } from "./sparkline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Row = { taken_at: string; payload: unknown } | undefined;
const dataOf = <T,>(row: Row): T | null => {
  const p = row?.payload as { status?: string; data?: T } | undefined;
  return p?.status === "ok" && p.data !== undefined ? p.data : null;
};
const noteOf = (row: Row): string | null => {
  const p = row?.payload as { status?: string; reason?: string } | undefined;
  if (!p) return null;
  if (p.status === "ok") return p.reason ?? null;
  return p.reason ?? (p.status === "skipped" ? "Not available on this site" : "Failed");
};

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-sm text-slate-400">—</span>;
  const cls = score >= 80 ? "bg-green-100 text-green-800"
    : score >= 50 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800";
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{score}</span>;
}

export default async function SeoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();

  const seo = supabaseSeoRepo(db);
  const [latest, auditHistory, lastRun] = await Promise.all([
    seo.latestBySource(id), seo.history(id, "rankmath_audit", 20), seo.lastRunAt(id),
  ]);

  const audit = dataOf<AuditPayload>(latest.rankmath_audit);
  const pages = dataOf<{ pages: PageScore[] }>(latest.rankmath_scores)?.pages ?? [];
  const links = dataOf<{ stats: LinkStats; upgrade: string | null }>(latest.links);
  const keywords = dataOf<KeywordsPayload>(latest.keywords);
  const aeo = dataOf<AiVisibilityPayload>(latest.ai_visibility);
  const psi = dataOf<PsiPayload>(latest.psi);

  const trend = trendPoints(auditHistory, (p) => {
    const d = (p as { data?: { score?: number | null } })?.data;
    return typeof d?.score === "number" ? d.score : null;
  });

  const scan = runSeoScanAction.bind(null, id) as unknown as ManageFormAction;
  const failing = (audit?.findings ?? []).filter((f) => f.status === "fail" || f.status === "warning");

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">SEO &amp; AEO</p>
      <SiteTabs siteId={id} active="seo" />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div>
            <p className="text-3xl font-bold">{audit?.score ?? "—"}<span className="text-base font-normal text-slate-400">/100</span></p>
            <p className="text-xs text-slate-500">
              Rank Math site audit{audit?.grade ? ` · ${audit.grade}` : ""}
              {lastRun ? ` · ${new Date(lastRun).toLocaleString()}` : " · never run"}
            </p>
          </div>
          <Sparkline points={trend} label="SEO audit score" />
        </div>
        <ManageForm action={scan} label="Run SEO scan" pendingLabel="Scanning… (up to a few minutes)"
          confirmMessage={`Run a full SEO scan on ${site.name} now?`}
          buttonClassName="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50" />
      </div>

      {psi && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Performance (mobile)", value: psi.mobile?.performance ?? null },
            { label: "SEO (mobile)", value: psi.mobile?.seo ?? null },
            { label: "Accessibility", value: psi.mobile?.accessibility ?? null },
            { label: "Performance (desktop)", value: psi.desktop?.performance ?? null },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border bg-white p-3 text-center shadow-sm">
              <p className="text-lg font-semibold">{s.value ?? "—"}</p>
              <p className="text-xs text-slate-500">{s.label}</p>
            </div>
          ))}
        </div>
      )}
      {noteOf(latest.psi) && <p className="mb-4 text-xs text-amber-700">PageSpeed: {noteOf(latest.psi)}</p>}

      <section className="mb-6 rounded-lg border bg-white shadow-sm">
        <h2 className="border-b px-4 py-3 font-medium">
          Audit findings {failing.length > 0 && <span className="text-amber-700">({failing.length} need attention)</span>}
        </h2>
        {!audit ? (
          <p className="px-4 py-6 text-sm text-slate-500">{noteOf(latest.rankmath_audit) ?? "Run a scan to see audit findings."}</p>
        ) : failing.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">No failing tests. {audit.total_tests ?? 0} checks run.</p>
        ) : (
          <ul className="divide-y">
            {failing.slice(0, 20).map((f) => (
              <li key={f.test_id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{f.title}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${
                    f.status === "fail" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}>
                    {f.status}
                  </span>
                </div>
                {f.fix_text && <p className="mt-1 text-xs text-slate-600">{f.fix_text}</p>}
                {f.kb_link && (
                  <a href={f.kb_link} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs underline">
                    How to fix
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-lg border bg-white shadow-sm">
          <h2 className="border-b px-4 py-3 font-medium">Pages needing attention</h2>
          {pages.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">{noteOf(latest.rankmath_scores) ?? "No page scores yet."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-2">Page</th>
                    <th className="px-4 py-2">Focus keyword</th>
                    <th className="px-4 py-2">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {[...pages].sort((a, b) => (a.score ?? 101) - (b.score ?? 101)).slice(0, 10).map((p) => (
                    <tr key={p.post_id} className="border-b last:border-0">
                      <td className="max-w-64 truncate px-4 py-2" title={p.title}>{p.title}</td>
                      <td className="max-w-40 truncate px-4 py-2 text-slate-500">{p.keyword ?? "— none —"}</td>
                      <td className="px-4 py-2"><ScoreBadge score={p.score} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-lg border bg-white shadow-sm">
          <h2 className="border-b px-4 py-3 font-medium">Search Console keywords</h2>
          {!keywords ? (
            <p className="px-4 py-6 text-sm text-slate-500">{noteOf(latest.keywords) ?? "No keyword data yet."}</p>
          ) : !keywords.connected ? (
            <p className="px-4 py-6 text-sm text-slate-500">
              Google Search Console is not connected in Rank Math on this site.
            </p>
          ) : keywords.keywords.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">No keyword impressions in the last 30 days.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-2">Keyword</th>
                    <th className="px-4 py-2">Clicks</th>
                    <th className="px-4 py-2">Impr.</th>
                    <th className="px-4 py-2">Pos.</th>
                  </tr>
                </thead>
                <tbody>
                  {keywords.keywords.slice(0, 10).map((k) => (
                    <tr key={k.keyword} className="border-b last:border-0">
                      <td className="max-w-56 truncate px-4 py-2" title={k.keyword}>{k.keyword}</td>
                      <td className="px-4 py-2">{k.clicks}</td>
                      <td className="px-4 py-2">{k.impressions}</td>
                      <td className="px-4 py-2">{k.position.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">AI Visibility (AEO)</h2>
          {!aeo ? (
            <p className="text-sm text-slate-500">{noteOf(latest.ai_visibility) ?? "No AEO data yet."}</p>
          ) : aeo.brands.length === 0 ? (
            <p className="text-sm text-slate-500">
              No brands tracked yet. Add a brand in Rank Math → AI Visibility to start measuring how AI assistants cite this site.
            </p>
          ) : (
            <ul className="space-y-3 text-sm">
              {aeo.brands.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{b.name}</p>
                    <p className="text-xs text-slate-500">
                      {b.mentions ?? 0} mentions · {b.citations ?? 0} citations
                      {b.analysis_status ? ` · ${b.analysis_status}` : ""}
                    </p>
                  </div>
                  <ScoreBadge score={b.score} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">Links</h2>
          {!links ? (
            <p className="text-sm text-slate-500">{noteOf(latest.links) ?? "No link report yet."}</p>
          ) : (
            <>
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-slate-500">Internal links</dt><dd>{links.stats.total_internal}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">External links</dt><dd>{links.stats.total_external}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Posts with no internal links</dt><dd>{links.stats.posts_no_internal}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Posts with no external links</dt><dd>{links.stats.posts_no_external}</dd></div>
              </dl>
              {links.upgrade && <p className="mt-3 text-xs text-slate-500">{links.upgrade}</p>}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
