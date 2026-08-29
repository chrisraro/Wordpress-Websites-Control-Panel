import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { requireSiteAccess } from "@/lib/authz/server";
import { readDbFor } from "@/lib/authz/db";
import { can } from "@/lib/authz/decide";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { trendPoints } from "@/services/seo/types";
import type {
  AiVisibilityPayload, AuditPayload, KeywordsPayload, LinkStats, PageScore, PsiPayload,
} from "@/services/seo/types";
import { SiteTabs } from "../tabs";
import { ManageForm } from "../action-form";
import { runSeoScanAction } from "../seo-actions";
import { Sparkline } from "./sparkline";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import {
  Card, CardTitle, EmptyState, Stat, StatusBadge, type StatusTone,
} from "@/components/ui/primitives";
import { cardClass, tableCellClass, tableHeadClass, tableRowClass } from "@/components/ui/styles";
import { IconExternal, IconSearch } from "@/components/ui/icons";

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

function scoreTone(score: number): StatusTone {
  return score >= 80 ? "good" : score >= 50 ? "warn" : "bad";
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-caption tracking-normal text-mid-gray">—</span>;
  return <StatusBadge tone={scoreTone(score)}>{score}</StatusBadge>;
}

export default async function SeoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireSiteAccess(id);
  const db = await readDbFor(viewer);
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

  const scan = runSeoScanAction.bind(null, id);
  const failing = (audit?.findings ?? []).filter(
    (f) => f.status === "fail" || f.status === "warning",
  );
  const psiNote = noteOf(latest.psi);

  return (
    <main>
      <Breadcrumbs
        items={[
          { label: "Sites", href: "/dashboard" },
          { label: site.name, href: `/sites/${id}` },
          { label: "SEO & AEO" },
        ]}
      />
      <h1 className="mb-6 text-heading-sm font-semibold text-ink">{site.name}</h1>
      <SiteTabs siteId={id} active="seo" />

      <div className={`${cardClass} mb-4 flex flex-wrap items-center justify-between gap-6 p-5`}>
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <p className="text-caption font-medium uppercase text-mid-gray">Site audit</p>
            <p data-tabular className="mt-1 text-heading font-semibold text-ink">
              {audit?.score ?? "—"}
              <span className="text-body-lg font-normal text-mid-gray">/100</span>
            </p>
            <p className="mt-1 text-caption tracking-normal text-mid-gray">
              Rank Math{audit?.grade ? ` · grade ${audit.grade}` : ""}
              {lastRun ? ` · ${new Date(lastRun).toLocaleString()}` : " · never run"}
            </p>
          </div>
          <Sparkline points={trend} label="SEO audit score" />
        </div>
        {can(viewer, "seo.run") && (
          <ManageForm
            action={scan}
            label="Run SEO scan"
            pendingLabel="Scanning…"
            success="SEO scan complete"
            variant="primary"
            icon={<IconSearch size={16} />}
            confirm={{
              title: "Run a full SEO scan?",
              description: `Collects the Rank Math audit, per-page scores, Search Console keywords, AI visibility, and PageSpeed data for ${site.name}. It reads only, and can take a few minutes.`,
              confirmLabel: "Run scan",
            }}
            showInlineError={false}
          />
        )}
      </div>

      {psi && (
        <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[
            { label: "Performance mobile", value: psi.mobile?.performance ?? null },
            { label: "SEO mobile", value: psi.mobile?.seo ?? null },
            { label: "Accessibility", value: psi.mobile?.accessibility ?? null },
            { label: "Performance desktop", value: psi.desktop?.performance ?? null },
          ].map((s) => (
            <Stat
              key={s.label}
              label={s.label}
              value={s.value ?? "—"}
              tone={s.value === null ? undefined : scoreTone(s.value)}
            />
          ))}
        </div>
      )}
      {psiNote && (
        <p className="mb-4 flex items-center gap-2 text-body text-mid-gray">
          <StatusBadge tone="warn">PageSpeed</StatusBadge>
          {psiNote}
        </p>
      )}

      <Card className="mb-4">
        <CardTitle
          aside={
            failing.length > 0 ? (
              <StatusBadge tone="warn">{failing.length} need attention</StatusBadge>
            ) : audit ? (
              <StatusBadge tone="good">All passing</StatusBadge>
            ) : undefined
          }
        >
          Audit findings
        </CardTitle>
        {!audit ? (
          <p className="px-5 py-6 text-body text-mid-gray">
            {noteOf(latest.rankmath_audit) ?? "Run a scan to see audit findings."}
          </p>
        ) : failing.length === 0 ? (
          <p className="px-5 py-6 text-body text-mid-gray">
            Nothing failing across {audit.total_tests ?? 0} checks.
          </p>
        ) : (
          <ul className="divide-y divide-hairline">
            {failing.slice(0, 20).map((f) => (
              <li key={f.test_id} className="px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-body font-medium text-ink">{f.title}</span>
                  <StatusBadge tone={f.status === "fail" ? "bad" : "warn"}>{f.status}</StatusBadge>
                </div>
                {f.fix_text && (
                  <p className="mt-1 max-w-prose text-body text-mid-gray">{f.fix_text}</p>
                )}
                {f.kb_link && (
                  <a
                    href={f.kb_link}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-caption tracking-normal
                      text-mid-gray underline transition-colors duration-150 hover:text-ink"
                  >
                    How to fix
                    <IconExternal size={12} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardTitle>Pages needing attention</CardTitle>
          {pages.length === 0 ? (
            <p className="px-5 py-6 text-body text-mid-gray">
              {noteOf(latest.rankmath_scores) ?? "No page scores collected yet."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-body">
                <thead>
                  <tr className={tableHeadClass}>
                    <th className="px-5 py-3 font-medium">Page</th>
                    <th className="px-5 py-3 font-medium">Focus keyword</th>
                    <th className="px-5 py-3 font-medium">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {[...pages]
                    .sort((a, b) => (a.score ?? 101) - (b.score ?? 101))
                    .slice(0, 10)
                    .map((p) => (
                      <tr key={p.post_id} className={tableRowClass}>
                        <td className={`${tableCellClass} max-w-64 truncate text-ink`} title={p.title}>
                          {p.title}
                        </td>
                        <td className={`${tableCellClass} max-w-40 truncate text-mid-gray`}>
                          {p.keyword ?? "none set"}
                        </td>
                        <td className={tableCellClass}>
                          <ScoreBadge score={p.score} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardTitle>Search Console keywords</CardTitle>
          {!keywords ? (
            <p className="px-5 py-6 text-body text-mid-gray">
              {noteOf(latest.keywords) ?? "No keyword data collected yet."}
            </p>
          ) : !keywords.connected ? (
            <p className="px-5 py-6 text-body text-mid-gray">
              Google Search Console is not connected in Rank Math on this site. Connect it there
              and the next scan will pull query data.
            </p>
          ) : keywords.keywords.length === 0 ? (
            <p className="px-5 py-6 text-body text-mid-gray">
              No impressions recorded in the last 30 days.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-body">
                <thead>
                  <tr className={tableHeadClass}>
                    <th className="px-5 py-3 font-medium">Keyword</th>
                    <th className="px-5 py-3 font-medium">Clicks</th>
                    <th className="px-5 py-3 font-medium">Impr.</th>
                    <th className="px-5 py-3 font-medium">Pos.</th>
                  </tr>
                </thead>
                <tbody>
                  {keywords.keywords.slice(0, 10).map((k) => (
                    <tr key={k.keyword} className={tableRowClass}>
                      <td className={`${tableCellClass} max-w-56 truncate text-ink`} title={k.keyword}>
                        {k.keyword}
                      </td>
                      <td className={tableCellClass}>{k.clicks}</td>
                      <td className={tableCellClass}>{k.impressions}</td>
                      <td className={tableCellClass}>{k.position.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>AI visibility</CardTitle>
          {!aeo ? (
            <p className="px-5 py-6 text-body text-mid-gray">
              {noteOf(latest.ai_visibility) ?? "No AI visibility data collected yet."}
            </p>
          ) : aeo.brands.length === 0 ? (
            <EmptyState title="No brands tracked yet">
              Add a brand in Rank Math → AI Visibility to start measuring how often assistants
              mention and cite this site.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-hairline px-5">
              {aeo.brands.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-body font-medium text-ink">{b.name}</p>
                    <p className="text-caption tracking-normal text-mid-gray">
                      {b.mentions ?? 0} mentions · {b.citations ?? 0} citations
                      {b.analysis_status ? ` · ${b.analysis_status}` : ""}
                    </p>
                  </div>
                  <ScoreBadge score={b.score} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle>Links</CardTitle>
          {!links ? (
            <p className="px-5 py-6 text-body text-mid-gray">
              {noteOf(latest.links) ?? "No link report collected yet."}
            </p>
          ) : (
            <>
              <dl className="divide-y divide-hairline px-5 text-body">
                {[
                  { term: "Internal links", value: links.stats.total_internal },
                  { term: "External links", value: links.stats.total_external },
                  { term: "Posts with no internal links", value: links.stats.posts_no_internal },
                  { term: "Posts with no external links", value: links.stats.posts_no_external },
                ].map((row) => (
                  <div key={row.term} className="flex items-baseline justify-between gap-4 py-2.5">
                    <dt className="text-mid-gray">{row.term}</dt>
                    <dd data-tabular className="text-ink">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
              {links.upgrade && (
                <p className="border-t border-hairline px-5 py-3 text-caption tracking-normal text-mid-gray">
                  {links.upgrade}
                </p>
              )}
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
