import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseReportsRepo } from "@/services/reports/repo";
import { SiteTabs } from "../tabs";
import { ManageForm, type ManageFormAction } from "../action-form";
import { revokeReportAction } from "../reports-actions";
import { GenerateReportForm } from "./generate-form";

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
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">Reports</p>
      <SiteTabs siteId={id} active="reports" />

      <section className="mb-6">
        <h2 className="mb-2 font-medium">Generate a report</h2>
        <p className="mb-3 text-sm text-slate-500">
          Reports are built from the data already collected by scans — generating one never
          contacts the website, so it takes a few seconds.
        </p>
        <GenerateReportForm siteId={id} />
      </section>

      <section className="rounded-lg border bg-white shadow-sm">
        <h2 className="border-b px-4 py-3 font-medium">Generated reports</h2>
        {reports.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">No reports yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2">Generated</th>
                  <th className="px-4 py-2">Sections</th>
                  <th className="px-4 py-2">Source</th>
                  <th className="px-4 py-2">Share link</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => {
                  const revoke = revokeReportAction.bind(null, id, r.id) as unknown as ManageFormAction;
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-4 py-2">{new Date(r.generated_at).toLocaleString()}</td>
                      <td className="px-4 py-2">
                        {r.sections.map((s) => SECTION_LABELS[s] ?? s).join(", ")}
                      </td>
                      <td className="px-4 py-2">{r.auto ? "Monthly" : "Manual"}</td>
                      <td className="px-4 py-2">
                        {r.share_token ? (
                          <a href={`/r/${r.share_token}`} target="_blank" rel="noreferrer"
                            className="underline">Open</a>
                        ) : (
                          <span className="text-slate-400">Revoked</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex justify-end">
                          {r.share_token && (
                            <ManageForm action={revoke} label="Revoke link" pendingLabel="Revoking…"
                              confirmMessage="Revoke this share link? Anyone holding it will lose access." />
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
      </section>
    </main>
  );
}
