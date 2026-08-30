import Link from "next/link";
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { requireSiteAccess } from "@/lib/authz/server";
import { readDbFor } from "@/lib/authz/db";
import { can } from "@/lib/authz/decide";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { averageRank, coverage, measuredCount, resolveRunPreview } from "@/services/geogrid/types";
import { isOpenJobStatus } from "@/services/jobs/service";
import { SiteTabs } from "../tabs";
import { SiteHeading } from "../site-heading";
import { ManageForm } from "../action-form";
import { runGeoGridAction, dismissFailedGeoGridRunsAction } from "../geogrid-actions";
import { drainQueueAction } from "../../../queue-actions";
import { GeoGridConfigForm } from "./config-form";
import { GridMap } from "./grid-map";
import { GeoGridRunPoller } from "./run-poller";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { Card, CardTitle, EmptyState, Stat, StatusBadge } from "@/components/ui/primitives";
import { cardClass, tableCellClass, tableHeadClass, tableRowClass } from "@/components/ui/styles";
import { IconMap } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default async function GeoGridPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ k?: string; run?: string }> }) {
  const { id } = await params;
  const { k, run } = await searchParams;
  const viewer = await requireSiteAccess(id);
  const db = await readDbFor(viewer);
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs: supabaseJobsRepo(db) }, id);
  if (!site) notFound();

  const canManageGeoGrid = can(viewer, "geogrid.manage");
  const canProcessQueue = can(viewer, "queue.process");

  const geogrid = supabaseGeoGridRepo(db);
  const config = await geogrid.getConfigBySite(id);
  const latest = config ? await geogrid.latestPerKeyword(config.id) : {};
  const keyword = k && config?.keywords.includes(k) ? k : config?.keywords[0];
  const current = keyword ? latest[keyword] : undefined;
  const history = config && keyword ? await geogrid.historyForKeyword(config.id, keyword, 10) : [];

  // Surface in-flight and failed runs: without this a stuck n8n callback looks
  // identical to "never scanned".
  const { data: runJobs, error: runJobsError } = await db
    .from("jobs")
    .select("status,attempts,last_error,payload,scheduled_for,dismissed_at")
    .eq("site_id", id).eq("type", "geogrid_run")
    .order("scheduled_for", { ascending: false })
    .limit(20);
  // A deploy of this query ahead of migration 0015 (adds `dismissed_at`)
  // makes PostgREST 400 on the unknown column, `data` comes back null, and
  // both alerts below silently vanish through the `?? []` fallbacks — the
  // exact "stuck run looks like never scanned" failure the comment above
  // says this block exists to prevent. Surface it instead of swallowing it.
  if (runJobsError) {
    console.error(`GeoGrid page: failed to load run jobs for site ${id}`, runJobsError);
  }
  const openRuns = (runJobs ?? []).filter((j) => isOpenJobStatus(j.status));
  // Dismissed failures stay in the table (and in runJobs above, for anything
  // that ever inspects the raw rows) — they are just left out of this alert.
  const failedRuns = (runJobs ?? []).filter((j) => j.status === "failed" && !j.dismissed_at);

  const runAction = runGeoGridAction.bind(null, id);
  const dismissFailed = dismissFailedGeoGridRunsAction.bind(null, id);
  const drainQueue = drainQueueAction.bind(null, `/sites/${id}/geogrid`);

  // Which run the map and stats below show: the `run` query param (a
  // snapshot id) if it resolves against this keyword's loaded history,
  // otherwise the latest — see resolveRunPreview for why an unrecognised id
  // falls back rather than erroring. The stats derive from `previewed`
  // throughout so they can never show one run's numbers over another run's
  // map (see isPreviewingPast below).
  const preview = resolveRunPreview(history, run);
  const previewed = preview.snapshot ?? current;
  const previousSnap = history[preview.index + 1];
  const isPreviewingPast = preview.isPast;
  const avg = previewed ? averageRank(previewed.points) : null;
  const cov = previewed ? coverage(previewed.points) : 0;
  const currentMeasured = previewed ? measuredCount(previewed.points) : 0;
  const currentTotal = previewed ? previewed.points.length : 0;
  const currentHasGap = previewed !== undefined && currentMeasured < currentTotal;
  const prevAvg = previousSnap ? averageRank(previousSnap.points) : null;
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
      <SiteHeading site={site} className="mb-0" />
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
                          className={`flex min-h-9 items-center whitespace-nowrap rounded-2xl px-3 pointer-coarse:min-h-11
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

            {canManageGeoGrid && (
              <ManageForm
                action={runAction}
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
              />
            )}
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
              {canProcessQueue && (
                <ManageForm
                  action={drainQueue}
                  label="Process queue now"
                  pendingLabel="Processing…"
                  success="Queue processed"
                />
              )}
            </div>
          )}

          {failedRuns.length > 0 && (
            <div className={`${cardClass} mb-4 p-5`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="bad">
                    {failedRuns.length} failed
                  </StatusBadge>
                  <p className="text-body font-medium text-ink">Recent runs did not complete</p>
                </div>
                {canManageGeoGrid && (
                  <ManageForm
                    action={dismissFailed}
                    label="Dismiss"
                    pendingLabel="Dismissing…"
                    success="Failed runs dismissed"
                    size="sm"
                    confirm={{
                      title: "Dismiss failed runs?",
                      description:
                        "This dismisses all failed GeoGrid runs for this site, not just the ones shown above — the runs stay in the record for diagnosis, this only clears the alert.",
                      confirmLabel: "Dismiss",
                    }}
                  />
                )}
              </div>
              <p className="mt-1 break-words text-body text-mid-gray">
                {failedRuns[0].last_error ?? "No error was recorded."}
              </p>
            </div>
          )}

          {/* Renders nothing — see run-poller.tsx. Refreshes this page and
              toasts the outcome once every open run for this site settles,
              so the tab never needs a manual reload to find out. */}
          <GeoGridRunPoller siteId={id} active={openRuns.length > 0} />

          {isPreviewingPast && previewed && (
            <div className={`${cardClass} mb-4 flex flex-wrap items-center gap-3 p-4`}>
              <StatusBadge tone="info">Past run</StatusBadge>
              <p className="text-body text-mid-gray">
                Showing {keyword} from {new Date(previewed.run_at).toLocaleString()} — not the
                latest scan. The map and stats below are scoped to this run.
              </p>
              <Link
                href={`/sites/${id}/geogrid?k=${encodeURIComponent(keyword ?? "")}`}
                className="ml-auto text-body font-medium text-ink underline underline-offset-2"
              >
                View latest
              </Link>
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
              value={currentMeasured === 0 ? "—" : `${cov}%`}
              // No tone when there's no data to assert a reading over, and no
              // tone when there's a gap either: a coloured figure is the
              // loudest thing on the card, and both "0% because nothing was
              // measured" and "100% from 1 of 81 points" read as confident
              // signal at a glance if this were still coloured. The hint
              // carries the meaning in both cases instead.
              tone={
                currentMeasured === 0 || currentHasGap
                  ? undefined
                  : cov >= 70 ? "good" : cov >= 30 ? "warn" : "bad"
              }
              hint={
                currentMeasured === 0
                  ? "Not enough data"
                  : currentHasGap
                  ? `Points in the top 20 · ${currentMeasured} of ${currentTotal} measured`
                  : "Points in the top 20"
              }
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
              points={previewed?.points ?? []}
              center={{ lat: config.center_lat, lng: config.center_lng }}
              businessName={config.business_name}
            />
            {previewed ? (
              <p className="mt-2 flex flex-wrap items-center gap-x-2 text-caption tracking-normal text-mid-gray">
                <span>{keyword}</span>
                <span>· scanned {new Date(previewed.run_at).toLocaleString()}</span>
                {/* Every stop the map can paint, not just the ends. The
                    legend named "top 3" and "outside the top 20" while
                    colourFor() in grid-map.tsx uses five ramp colours, so
                    ranks 4-15 -- three of the five -- had no entry and the
                    legend was wrong by omission. Kept in the same order as
                    the ramp so it reads as a scale. */}
                <span className="inline-flex flex-wrap items-center gap-x-1.5">
                  ·
                  <span aria-hidden className="size-1.5 rounded-full bg-rank-1" />
                  1–3
                  <span aria-hidden className="ml-1 size-1.5 rounded-full bg-rank-2" />
                  4–7
                  <span aria-hidden className="ml-1 size-1.5 rounded-full bg-rank-3" />
                  8–10
                  <span aria-hidden className="ml-1 size-1.5 rounded-full bg-rank-4" />
                  11–15
                  <span aria-hidden className="ml-1 size-1.5 rounded-full bg-rank-5" />
                  16+
                  {currentHasGap && (
                    <>
                      <span aria-hidden className="ml-1 size-1.5 rounded-full bg-rank-unmeasured" />
                      not measured
                    </>
                  )}
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
              <p className="px-5 pb-2 pt-4 text-caption tracking-normal text-mid-gray sm:hidden">
                Tap a run to preview it on the map above.
              </p>
              <div className="scroll-x-hint">
                <table className="w-full min-w-[420px] text-body">
                  <thead>
                    <tr className={tableHeadClass}>
                      <th scope="col" className="px-5 py-3 font-medium">Run</th>
                      <th scope="col" className="px-5 py-3 font-medium">Average rank</th>
                      <th scope="col" className="px-5 py-3 font-medium">Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((snap, i) => {
                      const measured = measuredCount(snap.points);
                      const total = snap.points.length;
                      const isSelected = snap.id === preview.snapshot?.id;
                      const runDate = new Date(snap.run_at).toLocaleString();
                      return (
                        // `relative` on the row is what a plain absolutely-
                        // positioned link inside one cell can anchor to,
                        // stretching that link to cover the full row — a big
                        // click target built from a real, keyboard-reachable
                        // <a>, not a `<tr onClick>` (which is neither).
                        <tr
                          key={snap.id}
                          // A deeper fill than the hover state (surface-alt)
                          // so a selected row still reads as selected once
                          // the pointer moves away — colour is a supporting
                          // cue here, not the only one; aria-current and the
                          // "(showing)" text carry the state itself.
                          className={`relative ${tableRowClass} ${isSelected ? "bg-canvas" : ""}`}
                        >
                          <td className={tableCellClass}>
                            <Link
                              href={`/sites/${id}/geogrid?k=${encodeURIComponent(keyword ?? "")}&run=${snap.id}`}
                              // `aria-current`, not colour alone, is the
                              // selected state assistive tech gets — matches
                              // the keyword tabs above, which mark their own
                              // active tab the same way.
                              aria-current={isSelected ? "true" : undefined}
                              // A bare date is not enough context once this
                              // link is the only thing a screen reader
                              // announces for the row: name the keyword and
                              // whether it's the latest run too.
                              aria-label={`Preview the ${i === 0 ? "latest " : ""}${keyword} run from ${runDate} on the map${isSelected ? " (currently shown)" : ""}`}
                              className="absolute inset-0 rounded-2xl focus-visible:outline
                                focus-visible:outline-2 focus-visible:outline-offset-[-2px]
                                focus-visible:outline-ink"
                            />
                            <span>{runDate}</span>
                            {isSelected && (
                              <span className="ml-2 text-caption tracking-normal text-mid-gray">
                                (showing)
                              </span>
                            )}
                          </td>
                          <td className={tableCellClass}>
                            {averageRank(snap.points) ?? "—"}
                          </td>
                          <td className={tableCellClass}>
                            {measured === 0 ? (
                              // Matches the "Coverage" stat card above, which
                              // also reads "—" rather than "0%" when nothing
                              // was measured — a coverage percentage implies
                              // there was something to compute it over.
                              "—"
                            ) : (
                              <>
                                {coverage(snap.points)}%
                                {measured < total && (
                                  <span className="ml-1.5 text-caption tracking-normal text-mid-gray">
                                    ({measured}/{total} measured)
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      {canManageGeoGrid ? (
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
      ) : (
        !config && (
          <Card>
            <EmptyState icon={<IconMap size={28} />} title="Local ranking hasn't been set up yet">
              Once this site is configured for GeoGrid tracking, its local pack ranks will show up
              here.
            </EmptyState>
          </Card>
        )
      )}
    </main>
  );
}
