import Link from "next/link";
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { averageRank, coverage } from "@/services/geogrid/types";
import { SiteTabs } from "../tabs";
import { ManageForm } from "../action-form";
import { runGeoGridAction } from "../geogrid-actions";
import { drainQueueAction } from "../../../queue-actions";
import { GeoGridConfigForm } from "./config-form";
import { GridMap } from "./grid-map";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { Card, CardTitle, Stat, StatusBadge } from "@/components/ui/primitives";
import { cardClass, tableCellClass, tableHeadClass, tableRowClass } from "@/components/ui/styles";
import { IconMap } from "@/components/ui/icons";

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

  const run = runGeoGridAction.bind(null, id);
  const drainQueue = drainQueueAction.bind(null, `/sites/${id}/geogrid`);
  const avg = current ? averageRank(current.points) : null;
  const cov = current ? coverage(current.points) : 0;
  const previous = history[1];
  const prevAvg = previous ? averageRank(previous.points) : null;
  const delta = avg !== null && prevAvg !== null ? Math.round((prevAvg - avg) * 10) / 10 : null;

  return (
    <main>
      <Breadcrumbs
        items={[
          { label: "Sites", href: "/dashboard" },
          { label: site.name, href: `/sites/${id}` },
          { label: "GeoGrid" },
        ]}
      />
      <h1 className="text-heading-sm font-semibold text-ink">{site.name}</h1>
      <p className="mb-6 mt-1 text-body text-mid-gray">
        Where this business ranks in the local pack, measured point by point.
      </p>
      <SiteTabs siteId={id} active="geogrid" />

      {config && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            {config.keywords.length > 1 ? (
              <nav aria-label="Keyword" className="-mx-1 overflow-x-auto px-1 pb-1">
                <ul className="flex w-max gap-1 rounded-3xl bg-canvas p-1">
                  {config.keywords.map((kw) => {
                    const isActive = kw === keyword;
                    return (
                      <li key={kw}>
                        <Link
                          href={`/sites/${id}/geogrid?k=${encodeURIComponent(kw)}`}
                          aria-current={isActive ? "page" : undefined}
                          className={`flex min-h-9 items-center whitespace-nowrap rounded-2xl px-3
                            text-body transition-colors duration-150 ${
                              isActive
                                ? "bg-paper font-medium text-ink shadow-subtle"
                                : "text-mid-gray hover:text-ink"
                            }`}
                        >
                          {kw}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            ) : (
              <p className="text-body text-mid-gray">{keyword}</p>
            )}

            <ManageForm
              action={run}
              label={`Run scan (${config.keywords.length} keyword${config.keywords.length === 1 ? "" : "s"})`}
              pendingLabel="Queueing…"
              success="Scan queued"
              variant="primary"
              icon={<IconMap size={16} />}
              confirm={{
                title: "Queue a GeoGrid scan?",
                description: `One run per keyword (${config.keywords.length} total) will be queued using the ${config.provider} provider. ${
                  config.provider === "n8n"
                    ? "Your n8n workflow performs the lookups and posts ranks back, which may take a few minutes."
                    : "The stub provider returns sample ranks immediately — useful for checking the grid before spending on live lookups."
                }`,
                confirmLabel: "Queue scan",
              }}
              showInlineError={false}
            />
          </div>

          {openRuns.length > 0 && (
            <div
              className={`${cardClass} mb-4 flex flex-wrap items-center justify-between gap-3 p-5`}
              aria-live="polite"
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone="info">
                  {openRuns.length} in progress
                </StatusBadge>
                <p className="text-body text-mid-gray">
                  {openRuns.some((j) => j.status === "awaiting_callback")
                    ? "Waiting on results from your n8n workflow."
                    : "Queued. The scheduler runs these automatically once pg_cron is wired; run them now if you are impatient."}
                </p>
              </div>
              <ManageForm
                action={drainQueue}
                label="Process queue now"
                pendingLabel="Processing…"
                success="Queue processed"
                showInlineError={false}
              />
            </div>
          )}

          {failedRuns.length > 0 && (
            <div className={`${cardClass} mb-4 p-5`}>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone="bad">
                  {failedRuns.length} failed
                </StatusBadge>
                <p className="text-body font-medium text-ink">Recent runs did not complete</p>
              </div>
              <p className="mt-1 break-words text-body text-mid-gray">
                {failedRuns[0].last_error ?? "No error was recorded."}
              </p>
            </div>
          )}

          <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat
              label="Average rank"
              value={avg === null ? "—" : String(avg)}
              tone={avg === null ? undefined : avg <= 3 ? "good" : avg <= 10 ? "warn" : "bad"}
            />
            <Stat
              label="Coverage"
              value={`${cov}%`}
              tone={cov >= 70 ? "good" : cov >= 30 ? "warn" : "bad"}
              hint="Points in the top 20"
            />
            <Stat label="Grid" value={`${config.grid_size}×${config.grid_size}`} hint={`${config.spacing_m}m spacing`} />
            <Stat
              label="Vs previous"
              value={delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta}`}
              tone={delta === null || delta === 0 ? undefined : delta > 0 ? "good" : "bad"}
              hint={delta === null ? "Needs two runs" : "Positive means improved"}
            />
          </div>

          <div className="mb-4">
            <GridMap
              points={current?.points ?? []}
              center={{ lat: config.center_lat, lng: config.center_lng }}
              businessName={config.business_name}
            />
            {current ? (
              <p className="mt-2 flex flex-wrap items-center gap-x-2 text-caption tracking-normal text-mid-gray">
                <span>{keyword}</span>
                <span>· scanned {new Date(current.run_at).toLocaleString()}</span>
                <span className="inline-flex items-center gap-1.5">
                  ·
                  <span aria-hidden className="size-1.5 rounded-full bg-status-good" />
                  top 3
                  <span aria-hidden className="ml-1 size-1.5 rounded-full bg-status-bad" />
                  outside the top 20
                </span>
              </p>
            ) : (
              <p className="mt-2 text-caption tracking-normal text-mid-gray">
                Run a scan to plot this keyword. Each keyword is queued as its own job.
              </p>
            )}
          </div>

          {history.length > 1 && (
            <Card className="mb-4 overflow-hidden">
              <CardTitle>Run history — {keyword}</CardTitle>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-body">
                  <thead>
                    <tr className={tableHeadClass}>
                      <th className="px-5 py-3 font-medium">Run</th>
                      <th className="px-5 py-3 font-medium">Average rank</th>
                      <th className="px-5 py-3 font-medium">Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((snap) => (
                      <tr key={snap.id} className={tableRowClass}>
                        <td className={tableCellClass}>{new Date(snap.run_at).toLocaleString()}</td>
                        <td className={tableCellClass}>{averageRank(snap.points) ?? "—"}</td>
                        <td className={tableCellClass}>{coverage(snap.points)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      <section>
        <h2 className="mb-1 text-body font-medium text-ink">
          {config ? "Configuration" : "Set up GeoGrid"}
        </h2>
        <p className="mb-3 max-w-prose text-body text-mid-gray">
          {config
            ? "Changing the centre or spacing changes what future runs measure; past snapshots keep the grid they were taken on."
            : "Enter the business, the keywords to track, and the centre of the area to measure. Start with the stub provider to see how the grid looks, then switch to n8n for live ranks."}
        </p>
        <GeoGridConfigForm siteId={id} config={config} />
      </section>
    </main>
  );
}
