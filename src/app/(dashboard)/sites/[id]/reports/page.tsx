import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseReportsRepo } from "@/services/reports/repo";
import { SiteTabs } from "../tabs";
import { ManageForm } from "../action-form";
import { revokeReportAction } from "../reports-actions";
import { GenerateReportForm } from "./generate-form";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { Card, CardTitle, EmptyState, StatusBadge } from "@/components/ui/primitives";
import { CopyLinkButton } from "@/components/ui/copy-button";
import { tableCellClass, tableHeadClass, tableRowClass } from "@/components/ui/styles";
import { IconExternal, IconReport } from "@/components/ui/icons";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const SECTION_LABELS: Record<string, string> = {
  security: "Security", seo: "SEO", geogrid: "GeoGrid", inventory: "Inventory",
};

export default async function ReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();
  const reports = await supabaseReportsRepo(db).listForSite(id, 20);

  return (
    <main>
      <Breadcrumbs
        items={[
          { label: "Sites", href: "/dashboard" },
          { label: site.name, href: `/sites/${id}` },
          { label: "Reports" },
        ]}
      />
      <h1 className="text-heading-sm font-semibold text-ink">{site.name}</h1>
      <p className="mb-6 mt-1 text-body text-mid-gray">
        Branded PDFs built from data your scans already collected.
      </p>
      <SiteTabs siteId={id} active="reports" />

      <section className="mb-4">
        <h2 className="mb-1 text-body font-medium text-ink">Generate a report</h2>
        <p className="mb-3 max-w-prose text-body text-mid-gray">
          Generating never contacts the website — it reads stored snapshots — so it takes a few
          seconds. Run the scans you want reflected first.
        </p>
        <GenerateReportForm siteId={id} />
      </section>

      <Card className="overflow-hidden">
        <CardTitle>Generated reports</CardTitle>
        {reports.length === 0 ? (
          <EmptyState icon={<IconReport size={28} />} title="No reports yet">
            Generate one above, or wait for the monthly report that runs automatically on the
            first of each month.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-body">
              <thead>
                <tr className={tableHeadClass}>
                  <th className="px-5 py-3 font-medium">Generated</th>
                  <th className="px-5 py-3 font-medium">Sections</th>
                  <th className="px-5 py-3 font-medium">Source</th>
                  <th className="px-5 py-3 font-medium">Share link</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => {
                  const revoke = revokeReportAction.bind(null, id, r.id);
                  return (
                    <tr key={r.id} className={tableRowClass}>
                      <td className={`${tableCellClass} text-ink`}>
                        {new Date(r.generated_at).toLocaleString()}
                      </td>
                      <td className={`${tableCellClass} text-mid-gray`}>
                        {r.sections.map((s) => SECTION_LABELS[s] ?? s).join(", ")}
                      </td>
                      <td className={tableCellClass}>
                        <StatusBadge tone="idle">{r.auto ? "Monthly" : "Manual"}</StatusBadge>
                      </td>
                      <td className={tableCellClass}>
                        {r.share_token ? (
                          <a
                            href={`/r/${r.share_token}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 text-ink underline
                              transition-colors duration-150 hover:text-mid-gray"
                          >
                            Open
                            <IconExternal size={14} />
                          </a>
                        ) : (
                          <StatusBadge tone="idle">Revoked</StatusBadge>
                        )}
                      </td>
                      <td className={tableCellClass}>
                        <div className="flex flex-wrap items-start justify-end gap-2">
                          {r.share_token && (
                            <>
                              <CopyLinkButton path={`/r/${r.share_token}`} />
                              <ManageForm
                                action={revoke}
                                label="Revoke"
                                pendingLabel="Revoking…"
                                success="Share link revoked"
                                size="sm"
                                variant="danger"
                                confirm={{
                                  title: "Revoke this share link?",
                                  description:
                                    "Anyone holding the link loses access immediately, and the PDF stops being served. This cannot be undone — generate a new report to share again.",
                                  confirmLabel: "Revoke link",
                                  tone: "danger",
                                }}
                                showInlineError={false}
                              />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="mt-4 max-w-prose text-caption tracking-normal text-mid-gray">
        Share links are unguessable and carry no login, so anyone holding one can read the
        report. Revoke any that circulate further than you intended.
      </p>
    </main>
  );
}
