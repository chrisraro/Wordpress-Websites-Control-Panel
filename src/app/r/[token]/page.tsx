import { notFound } from "next/navigation";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseReportsRepo } from "@/services/reports/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { badgeClass, buttonClass, cardClass } from "@/components/ui/styles";
import { IconExternal, IconReport } from "@/components/ui/icons";

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
  const period =
    report.period_start && report.period_end
      ? `${new Date(report.period_start).toLocaleDateString()} – ${new Date(report.period_end).toLocaleDateString()}`
      : null;

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-4 py-12 sm:px-6">
      <p className="text-caption font-medium uppercase text-mid-gray">OCS — Website Report</p>
      <h1 className="mt-2 text-heading font-semibold text-ink">
        {site?.name ?? "Website report"}
      </h1>
      {site?.url && (
        <a
          href={site.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1.5 break-all text-body text-mid-gray
            underline transition-colors duration-150 hover:text-ink"
        >
          {site.url.replace(/^https?:\/\//, "")}
          <IconExternal size={14} className="shrink-0" />
        </a>
      )}

      <dl className={`${cardClass} animate-rise mt-8 divide-y divide-hairline px-5`}>
        {[
          { term: "Generated", value: new Date(report.generated_at).toLocaleDateString() },
          { term: "Period covered", value: period ?? "—" },
          { term: "Sections", value: String(report.sections.length) },
        ].map((row) => (
          <div key={row.term} className="flex items-baseline justify-between gap-4 py-3">
            <dt className="text-body text-mid-gray">{row.term}</dt>
            <dd className="text-body font-medium text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>

      <h2 className="mt-8 text-body font-medium text-ink">This report covers</h2>
      <ul className="mt-2 flex flex-wrap gap-2">
        {report.sections.map((s) => (
          <li key={s} className={badgeClass("outline")}>
            {SECTION_LABELS[s] ?? s}
          </li>
        ))}
      </ul>

      <a
        href={`/r/${token}/file`}
        target="_blank"
        rel="noreferrer"
        className={buttonClass("primary", "md", "mt-8")}
      >
        <IconReport size={16} />
        Open the PDF report
      </a>

      <p className="mt-12 border-t border-hairline pt-4 text-caption tracking-normal text-mid-gray">
        This link was shared with you by OCS and can be revoked at any time.
      </p>
    </main>
  );
}
