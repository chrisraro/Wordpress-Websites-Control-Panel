import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { averageRank, coverage } from "@/services/geogrid/types";
import { SiteTabs } from "../tabs";
import { ManageForm, type ManageFormAction } from "../action-form";
import { runGeoGridAction } from "../geogrid-actions";
import { processQueueNowAction } from "../../../queue-actions";
import { GeoGridConfigForm } from "./config-form";
import { GridMap } from "./grid-map";

export const dynamic = "force-dynamic";

export default async function GeoGridPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ k?: string }> }) {
  const { id } = await params;
  const { k } = await searchParams;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();

  const geogrid = supabaseGeoGridRepo(db);
  const config = await geogrid.getConfigBySite(id);
  const latest = config ? await geogrid.latestPerKeyword(config.id) : {};
  const keyword = k && config?.keywords.includes(k) ? k : config?.keywords[0];
  const current = keyword ? latest[keyword] : undefined;
  const history = config && keyword ? await geogrid.historyForKeyword(config.id, keyword, 10) : [];

  // Surface in-flight and failed runs: without this a stuck n8n callback looks
  // identical to "never scanned".
  const { data: runJobs } = await db
    .from("jobs")
    .select("status,attempts,last_error,payload,scheduled_for")
    .eq("site_id", id).eq("type", "geogrid_run")
    .order("scheduled_for", { ascending: false })
    .limit(20);
  const openRuns = (runJobs ?? []).filter(
    (j) => j.status === "pending" || j.status === "running" || j.status === "awaiting_callback",
  );
  const failedRuns = (runJobs ?? []).filter((j) => j.status === "failed");

  const run = runGeoGridAction.bind(null, id) as unknown as ManageFormAction;
  const drainQueue = processQueueNowAction.bind(null, `/sites/${id}/geogrid`) as unknown as ManageFormAction;
  const avg = current ? averageRank(current.points) : null;
  const cov = current ? coverage(current.points) : 0;
  const previous = history[1];
  const prevAvg = previous ? averageRank(previous.points) : null;
  const delta = avg !== null && prevAvg !== null ? Math.round((prevAvg - avg) * 10) / 10 : null;

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">GeoGrid — local rank by location</p>
      <SiteTabs siteId={id} active="geogrid" />

      {config && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {config.keywords.map((kw) => (
                <a key={kw} href={`/sites/${id}/geogrid?k=${encodeURIComponent(kw)}`}
                  aria-current={kw === keyword ? "page" : undefined}
                  className={`min-h-10 rounded-full border px-3 py-2 text-sm ${
                    kw === keyword ? "border-slate-900 bg-slate-900 text-white" : "hover:bg-slate-100"}`}>
                  {kw}
                </a>
              ))}
            </div>
            <ManageForm action={run} label={`Run scan (${config.keywords.length} keyword(s))`}
              pendingLabel="Queueing…"
              confirmMessage={`Queue a GeoGrid scan for ${config.keywords.length} keyword(s) using the ${config.provider} provider?`}
              buttonClassName="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50" />
          </div>

          {openRuns.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm"
              aria-live="polite">
              <p>
                {openRuns.length} run(s) in progress
                {openRuns.some((j) => j.status === "awaiting_callback")
                  ? " — waiting on results from n8n."
                  : " — queued. The scheduled queue runs on your deployment; locally, run it yourself."}
              </p>
              <ManageForm action={drainQueue} label="Process queue now" pendingLabel="Processing…"
                confirmMessage="Run the queued jobs now?" />
            </div>
          )}
          {failedRuns.length > 0 && (
            <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm">
              <p className="font-medium">{failedRuns.length} recent run(s) failed</p>
              <p className="mt-1 break-words text-xs text-red-700">
                {failedRuns[0].last_error ?? "No error recorded"}
              </p>
            </div>
          )}

          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Average rank", value: avg === null ? "—" : String(avg) },
              { label: "Coverage", value: `${cov}%` },
              { label: "Grid", value: `${config.grid_size}×${config.grid_size} · ${config.spacing_m}m` },
              { label: "Change vs previous", value: delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta}` },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border bg-white p-3 text-center shadow-sm">
                <p className="text-lg font-semibold">{s.value}</p>
                <p className="text-xs text-slate-500">{s.label}</p>
              </div>
            ))}
          </div>

          <div className="mb-6">
            <GridMap points={current?.points ?? []}
              center={{ lat: config.center_lat, lng: config.center_lng }}
              businessName={config.business_name} />
            {current && (
              <p className="mt-2 text-xs text-slate-500">
                {keyword} · scanned {new Date(current.run_at).toLocaleString()} · green = top 3, red = not in the top 20
              </p>
            )}
            {!current && config.keywords.length > 0 && (
              <p className="mt-2 text-xs text-slate-500">
                No results stored for this keyword yet. “Run scan” queues a job per keyword; use
                “Process queue now” above to run them immediately.
              </p>
            )}
          </div>

          {history.length > 1 && (
            <section className="mb-6 rounded-lg border bg-white shadow-sm">
              <h2 className="border-b px-4 py-3 font-medium">Run history — {keyword}</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-2">Run</th>
                      <th className="px-4 py-2">Average rank</th>
                      <th className="px-4 py-2">Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((snap) => (
                      <tr key={snap.id} className="border-b last:border-0">
                        <td className="px-4 py-2">{new Date(snap.run_at).toLocaleString()}</td>
                        <td className="px-4 py-2">{averageRank(snap.points) ?? "—"}</td>
                        <td className="px-4 py-2">{coverage(snap.points)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      <section>
        <h2 className="mb-2 font-medium">{config ? "Configuration" : "Set up GeoGrid"}</h2>
        {!config && (
          <p className="mb-3 text-sm text-slate-500">
            Enter the business, the keywords to track, and the centre of the area to measure.
            Start with the stub provider to see how the grid looks; switch to n8n for live ranks.
          </p>
        )}
        <GeoGridConfigForm siteId={id} config={config} />
      </section>
    </main>
  );
}
