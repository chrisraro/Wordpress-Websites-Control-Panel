import { notFound } from "next/navigation";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseReportsRepo } from "@/services/reports/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";

export const dynamic = "force-dynamic";

// Shared reports are confidential: never let a pasted link get indexed.
export const metadata = { robots: { index: false, follow: false } };

const TOKEN_RE = /^[0-9a-f]{32}$/;

const SECTION_LABELS: Record<string, string> = {
  security: "Security", seo: "SEO & AEO", geogrid: "Local visibility", inventory: "Site inventory",
};

export default async function SharedReportPage({
  params,
}: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) notFound();

  const db = createServiceSupabase();
  const report = await supabaseReportsRepo(db).getByToken(token);
  if (!report) notFound();

  // Only the site's display name is shown — never its credentials or endpoint.
  const site = await supabaseSitesRepo(db).getSite(report.site_id);
  const period = report.period_start && report.period_end
    ? `${new Date(report.period_start).toLocaleDateString()} – ${new Date(report.period_end).toLocaleDateString()}`
    : null;

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-6 border-b pb-4">
        <p className="text-sm text-slate-500">OCS — Website Report</p>
        <h1 className="text-2xl font-semibold">{site?.name ?? "Website report"}</h1>
        {site?.url && (
          <a href={site.url} target="_blank" rel="noreferrer"
            className="break-all text-sm text-slate-500 underline">{site.url}</a>
        )}
      </div>

      <dl className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-white p-3">
          <dt className="text-xs text-slate-500">Generated</dt>
          <dd className="font-medium">{new Date(report.generated_at).toLocaleDateString()}</dd>
        </div>
        <div className="rounded-lg border bg-white p-3">
          <dt className="text-xs text-slate-500">Period</dt>
          <dd className="font-medium">{period ?? "—"}</dd>
        </div>
        <div className="rounded-lg border bg-white p-3">
          <dt className="text-xs text-slate-500">Sections</dt>
          <dd className="font-medium">{report.sections.length}</dd>
        </div>
      </dl>

      <p className="mb-2 text-sm font-medium">This report covers</p>
      <ul className="mb-6 flex flex-wrap gap-2">
        {report.sections.map((s) => (
          <li key={s} className="rounded-full border bg-white px-3 py-1 text-sm">
            {SECTION_LABELS[s] ?? s}
          </li>
        ))}
      </ul>

      <a href={`/r/${token}/file`} target="_blank" rel="noreferrer"
        className="inline-flex min-h-10 items-center rounded bg-slate-900 px-4 py-2 text-sm text-white">
        Open the PDF report
      </a>

      <p className="mt-8 text-xs text-slate-400">
        This link was shared with you by OCS and can be revoked at any time.
      </p>
    </main>
  );
}
