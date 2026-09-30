import Link from "next/link";
import { listSitesForViewer } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { requireViewer } from "@/lib/authz/server";
import { readDbFor } from "@/lib/authz/db";
import { can, canAccessSite } from "@/lib/authz/decide";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { supabaseMaintenanceRepo } from "@/services/maintenance/repo";
import { pendingUpdates, pendingPluginUpdates } from "@/services/inventory/types";
import { gscStatus } from "@/services/gsc/types";
import {
  siteAttention, isStagingSite, siteEnvironment, SEVERITY_RANK, type Severity,
} from "@/services/sites/portfolio";
import type { SiteEnvironment } from "@/services/sites/types";
import { ClientHome } from "./client-home";
import { loadClientEvidence } from "@/services/client/summary";
import { clientEvidenceDeps } from "@/services/client/deps";
import { LinkPending } from "@/components/shell/nav-progress";
import { FleetOverviewBand } from "./fleet-overview";
import { SiteCatalog } from "./site-catalog";
import type { CatalogSite } from "./site-card";
import {
  parseDirectoryQuery, queryDirectory, type DirectoryEnv, type DirectoryFields,
} from "@/services/sites/directory";
import { fleetOverview, liveness } from "@/services/sites/overview";
import { liveFrameUrl, sitePreviewUrl } from "@/services/sites/preview";
import { supabasePairingRepo } from "@/services/sites/pairing-repo";
import type { SiteRow } from "@/services/sites/types";
import { JOB_TYPE_LABEL, type JobRow, type JobType } from "@/services/jobs/types";
import { vulnFeedStatus } from "@/services/security/scan";
import { Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { badgeClass, buttonClass, cardClass } from "@/components/ui/styles";
import {
  IconAlert, IconChevronRight, IconUpload, IconPlugins, IconPlus, IconRefresh, IconShield, IconSites,
} from "@/components/ui/icons";
import { ManageForm } from "../sites/[id]/action-form";
import {
  refreshAllInventoryAction, dismissGlobalFailedJobsAction, updateAllPluginsAction, hardenFleetAction,
  setupBackupsFleetAction,
} from "./actions";
import { hardeningPlan, FIX_LABEL } from "@/services/security/harden";

export const dynamic = "force-dynamic";

interface Row {
  site: SiteRow;
  staging: boolean;
  severity: Severity;
  reasons: string[];
  updates?: number;
  /** Plugins only — what the fleet-wide plugin update will actually touch. */
  pluginUpdates: number;
  /** Search Console verification, from the same snapshot. null = unmeasured. */
  gsc: ReturnType<typeof gscStatus>;
  /** Hardening fixes the latest scan calls for. */
  hardenFixes: ReturnType<typeof hardeningPlan>;
  grade?: string;
  /** The scan behind `grade` could not check everything; see scanCoverage. */
  gradeIncomplete: boolean;
  seo?: number;
  /** Search, sort and summary fields, shared with the directory and overview. */
  fields: DirectoryFields;
  /** Latest uptime check's framing verdict (0029); null = unknown. */
  frameable: boolean | null;
}

/**
 * One site in the "Needs attention" list: a row stating its problems in
 * words, worst first. The full per-site metrics live on the cards in the
 * directory below; this list exists to say what needs doing.
 */
function AttentionRow({ row }: { row: Row }) {
  const { site, staging, severity, reasons } = row;
  return (
    <li className="border-b border-hairline last:border-0">
      <Link
        href={`/sites/${site.id}`}
        className="group flex items-start gap-3 px-5 py-4 transition-colors duration-150
          hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-2
          focus-visible:-outline-offset-2 focus-visible:outline-ink"
      >
        <span
          aria-hidden
          className={`mt-1.5 size-2 shrink-0 rounded-full ${
            severity === "critical" ? "bg-status-bad" : "bg-status-warn"}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-body font-medium text-ink">{site.name}</span>
            <span className={staging
              ? badgeClass("solid", "uppercase tracking-[0.08em]")
              : badgeClass("outline", "uppercase tracking-[0.08em]")}>
              {staging ? "Staging" : "Live"}
            </span>
          </div>
          <p className="truncate text-caption tracking-normal text-mid-gray">
            {site.url.replace(/^https?:\/\//, "")}
            {site.client_label && ` · ${site.client_label}`}
          </p>
          <ul className="mt-2 space-y-1">
            {reasons.map((r) => (
              <li
                key={r}
                className={`text-caption tracking-normal ${
                  severity === "critical" ? "text-status-bad" : "text-status-warn"}`}
              >
                {r}
              </li>
            ))}
          </ul>
        </div>
        <span className="mt-0.5 flex shrink-0 items-center">
          <LinkPending spinner>
            <IconChevronRight
              size={16}
              className="text-mid-gray transition-transform duration-150 group-hover:translate-x-0.5"
            />
          </LinkPending>
        </span>
      </Link>
    </li>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; env?: string; sort?: string; page?: string }>;
}) {
  const query = parseDirectoryQuery(await searchParams);
  // The fleet-wide writes (refresh, update, harden) still act on exactly one
  // environment -- PRODUCT.md's wrong-environment mistake -- and name it in
  // their labels. Live unless the directory is filtered to staging, because
  // live is what clients' visitors see.
  const activeEnv: SiteEnvironment = query.env === "staging" ? "staging" : "production";
  const viewer = await requireViewer();
  const db = await readDbFor(viewer);
  const jobsRepo = supabaseJobsRepo(db);
  const sites = await listSitesForViewer(
    { repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs: jobsRepo },
    viewer,
  );
  const canConnectSite = can(viewer, "sites.manage");

  // A client gets a different screen, not this one with pieces missing.
  //
  // This is the one place in the app that branches on the role name rather
  // than a permission, and the distinction is deliberate: every read below
  // is permission-gated on its own, and ClientHome's data is the same
  // viewer-scoped listSites the staff path uses. Branching here chooses a
  // *presentation*, and grants nothing -- so the objection the comment on
  // sites/[id]/page.tsx raises against role gates (they keep serving data the
  // database itself would refuse) does not apply. PRODUCT.md describes this
  // audience by role, not by capability: "someone who does not work at OCS
  // and did not ask for a control panel."
  if (viewer.role === "client") {
    const now = Date.now();
    // Viewer-scoped reads go through `db` (RLS); only the aggregate
    // maintenance count uses the service role, built and grant-gated in
    // src/services/client (deps.ts, summary.ts).
    const evidenceDeps = clientEvidenceDeps(db);
    const clientRows = await Promise.all(
      sites.map(async (site) => {
        const snap = await supabaseSnapshotsRepo(db).latestSnapshot(site.id);
        const updates = snap ? pendingUpdates(snap.payload) : undefined;
        const grade = (await supabaseSecurityRepo(db).latestGrade(site.id))?.grade;
        const evidence = await loadClientEvidence(
          evidenceDeps, viewer, site.id, { now, backup: snap?.payload.backup },
        );
        return {
          evidence,
          site,
          severity: siteAttention({ status: site.status, updates, grade }).severity,
          // null means never measured, and ClientHome must keep that
          // distinct from healthy -- this audience is the least able to tell
          // the difference (PRODUCT.md principle 4).
          lastCheckedIso: snap?.taken_at ?? null,
        };
      }),
    );
    return <ClientHome rows={clientRows} now={now} />;
  }

  // refreshAllInventoryAction (./actions.ts) checks both wp_toolkit.manage
  // and, per site, a "manage" grant -- the same pair refreshInventoryAction
  // (../sites/[id]/manage-actions.ts) enforces for a single site. This has
  // to mirror both checks and the "skip disabled sites" rule the nightly
  // fan-out uses (src/app/api/cron/enqueue/route.ts), or the button renders
  // (or promises a count) the action would not actually honour.
  //
  // Scoped to one environment (activeEnv), matching the action itself; the
  // label and confirmation name it, so the count is always checkable.
  const refreshTargets = sites.filter(
    (s) =>
      s.status !== "disabled" &&
      siteEnvironment(s) === activeEnv &&
      canAccessSite(viewer, s.id, "manage"),
  );
  const canRefreshAll = can(viewer, "wp_toolkit.manage") && refreshTargets.length > 0;

  const snapshots = supabaseSnapshotsRepo(db);
  const securityRepo = supabaseSecurityRepo(db);
  const seoRepo = supabaseSeoRepo(db);

  // System health: operator information, not customer information, so it's
  // gated the same as the queue-drain controls (queue.process) and both
  // extra reads below are skipped entirely for a viewer who can't see the
  // panel — a client's landing-page load pays nothing for this.
  //
  // These two reads are the only ones this feature adds to the dashboard,
  // and both are bounded (one row per failed job type, one row for the
  // feed's newest timestamp) — not one per site.
  const canSeeSystemHealth = can(viewer, "queue.process");
  const [globalFailures, feedStatus] = canSeeSystemHealth
    ? await Promise.all([
        jobsRepo.listGlobalFailures(),
        securityRepo.newestFeedUpdatedAt().then(vulnFeedStatus),
      ])
    : [[] as JobRow[], vulnFeedStatus(null)];
  // vuln_feed_refresh is the only job type enqueued with site_id: null today
  // (see handlers.ts), but grouping by type rather than assuming a single
  // group means a future site-less job type shows up correctly instead of
  // being silently merged into this one's alert.
  const failureGroups = Array.from(
    globalFailures.reduce((map, job) => {
      const arr = map.get(job.type) ?? [];
      arr.push(job);
      map.set(job.type, arr);
      return map;
    }, new Map<JobType, JobRow[]>()),
  ).map(([type, jobs]) => ({ type, jobs, latest: jobs[0] }));
  // canSeeSystemHealth guards this too: feedStatus is computed from a real
  // read only when the panel can be seen, so "fresh" (the harmless default
  // above) is what a viewer without queue.process gets regardless of the
  // feed's actual state — this never renders for them either way.
  const showSystemHealth =
    canSeeSystemHealth && (failureGroups.length > 0 || feedStatus.state !== "fresh");

  // One pass per site, all in flight together. Five bounded reads: the four
  // the row list always made plus the 24h uptime summary (at most 288 rows at
  // the 5-minute cadence), which the overview band and the cards' Up/Down
  // need. This is the landing screen and has to stay fast on a phone.
  // Explicit staging -> production pairs (0026) for the A-Z grouping. The
  // column is staff-only, read through the service-role `db` on the same
  // sites.view_all gate as the other staff-only reads; without it the
  // directory infers pairs from host and name instead.
  const explicitPairs = can(viewer, "sites.view_all")
    ? await supabasePairingRepo(db).listAllPairs().catch(() => new Map<string, string>())
    : new Map<string, string>();

  const rows: Row[] = await Promise.all(
    sites.map(async (site) => {
      const [snap, g, score, latestChecks, uptime] = await Promise.all([
        snapshots.latestSnapshot(site.id),
        securityRepo.latestGrade(site.id),
        seoRepo.latestAuditScore(site.id),
        securityRepo.latestChecks(site.id),
        // One failed read must not blank the dashboard: unknown uptime shows
        // as "Not checked", never as down.
        securityRepo.uptimeSummary(site.id).catch(() => null),
      ]);
      const updates = snap ? pendingUpdates(snap.payload) : undefined;
      const pluginUpdates = snap ? pendingPluginUpdates(snap.payload) : 0;
      const gsc = gscStatus(snap?.payload.gsc);
      const grade = g?.grade;
      const live = site.status === "disabled" ? { up: null, unconfirmed: false } : liveness(uptime);
      const up = live.up;
      const { severity, reasons } = siteAttention({ status: site.status, updates, grade, up });
      return {
        site,
        staging: isStagingSite(site),
        severity,
        reasons,
        updates,
        pluginUpdates,
        gsc,
        hardenFixes: latestChecks ? hardeningPlan(latestChecks.checks, { frameable: uptime?.frameable }) : [],
        grade,
        gradeIncomplete: (g?.incomplete?.length ?? 0) > 0,
        seo: score ?? undefined,
        frameable: uptime?.frameable ?? null,
        fields: {
          id: site.id,
          pairOf: explicitPairs.get(site.id) ?? null,
          name: site.name,
          url: site.url,
          clientLabel: site.client_label,
          env: siteEnvironment(site),
          status: site.status,
          severity,
          grade,
          updates,
          seo: score ?? undefined,
          up,
          downUnconfirmed: live.unconfirmed,
          uptime24h: uptime?.uptime24h ?? null,
          sslDays: uptime?.sslDays ?? null,
        },
      };
    }),
  );

  const byName = (a: Row, b: Row) => a.site.name.localeCompare(b.site.name);

  const overview = fleetOverview(rows.map((r) => r.fields));
  const envCounts: Record<DirectoryEnv, number> = {
    all: rows.length, live: overview.live, staging: overview.staging,
  };
  const directory = queryDirectory(rows, (r) => r.fields, query);
  const catalog: CatalogSite[] = directory.items.map((r) => ({
    id: r.site.id,
    fields: r.fields,
    reasons: r.reasons,
    gradeIncomplete: r.gradeIncomplete,
    gscProblem: r.gsc?.state === "none" || r.gsc?.state === "malformed" ? r.gsc.state : null,
    liveUrl: liveFrameUrl(r.site.url, r.frameable),
    previewSrc: sitePreviewUrl(r.site.url, r.fields.env),
  }));

  // The exception list stays a summary of the whole portfolio, independent
  // of whatever the directory below is filtered to.
  const needsAttention = rows
    .filter((r) => r.severity !== "ok")
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || byName(a, b));

  // The fleet writes act on one environment; see activeEnv.
  const visible = rows.filter((r) => siteEnvironment(r.site) === activeEnv);
  const envWord = activeEnv === "production" ? "live" : "staging";
  const anyConnected = rows.length > 0;

  // Sites in the action's environment with a plugin update waiting. Derived from the same
  // snapshot numbers the rows display, so the button can never claim work the
  // page does not show — and gated on the same pair the action enforces.
  const updateTargets = visible.filter(
    (r) =>
      r.site.status !== "disabled" &&
      r.pluginUpdates > 0 &&
      canAccessSite(viewer, r.site.id, "manage"),
  );
  const pendingUpdateCount = updateTargets.reduce((n, r) => n + r.pluginUpdates, 0);
  // Named, not just counted — but bounded, so a large fleet does not turn the
  // confirmation into a wall of text nobody reads, which would defeat the
  // point of naming them at all. At today's scale every site fits.
  const UPDATE_NAMES_SHOWN = 10;
  const updateNames = updateTargets.length <= UPDATE_NAMES_SHOWN
    ? updateTargets.map((r) => r.site.name).join(", ")
    : `${updateTargets.slice(0, UPDATE_NAMES_SHOWN).map((r) => r.site.name).join(", ")} ` +
      `and ${updateTargets.length - UPDATE_NAMES_SHOWN} more`;
  const canUpdateAll = can(viewer, "wp_toolkit.manage") && updateTargets.length > 0;

  // Same gate and the same environment scope as the plugin update: writes
  // into wp-content on live sites.
  const hardenTargets = visible.filter(
    (r) =>
      r.site.status !== "disabled" &&
      r.hardenFixes.length > 0 &&
      canAccessSite(viewer, r.site.id, "manage"),
  );
  const hardenFixCount = hardenTargets.reduce((n, r) => n + r.hardenFixes.length, 0);
  const canHardenFleet = can(viewer, "wp_toolkit.manage") && hardenTargets.length > 0;
  const hardenKinds = [...new Set(hardenTargets.flatMap((r) => r.hardenFixes))];

  // Maintenance windows (0027) for the sites the two fleet writes would
  // touch. Staff-only columns, read through the service-role `db` only on
  // the same sites.view_all gate as the site page's other staff-only reads;
  // without it the choice is simply not offered and everything runs now.
  const windows = can(viewer, "sites.view_all") && (canUpdateAll || canHardenFleet)
    ? await supabaseMaintenanceRepo(db).listWindows(
        [...new Set([...updateTargets, ...hardenTargets].map((r) => r.site.id))],
      )
    : null;
  const timingChoiceFor = (targets: { site: SiteRow }[]) => {
    const withWindow = windows ? targets.filter((r) => windows.get(r.site.id)).length : 0;
    if (withWindow === 0) return undefined;
    return {
      windowLabel: "In each site’s maintenance window",
      windowHint:
        withWindow === targets.length
          ? `Every site waits for its own next window.`
          : `${withWindow} of ${targets.length} sites wait for their own next window; ` +
            `the ${targets.length - withWindow} without one run now.`,
    };
  };
  const total = rows.length;
  const subtitle =
    total === 0
      ? undefined
      : needsAttention.length > 0
        ? `${needsAttention.length} of ${total} ${total === 1 ? "site needs" : "sites need"} attention`
        : `All ${total} ${total === 1 ? "site is" : "sites are"} healthy`;

  return (
    <main>
      <PageHeader
        title="Overview"
        subtitle={subtitle}
        actions={
          anyConnected && (
            <>
              {canRefreshAll && (
                <ManageForm
                  action={refreshAllInventoryAction.bind(null, activeEnv)}
                  label={`Refresh ${envWord} inventory`}
                  pendingLabel="Queuing…"
                  variant="outline"
                  icon={<IconRefresh size={16} />}

                  confirm={{
                    title: `Refresh inventory for ${refreshTargets.length} ${activeEnv} site${refreshTargets.length === 1 ? "" : "s"}?`,
                    description:
                      `This queues a fresh inventory scan for ${refreshTargets.length} ` +
                      `site${refreshTargets.length === 1 ? "" : "s"} — each one means connecting to the live ` +
                      "WordPress install and running code there. Jobs run in the background over the next " +
                      "minute or so; this doesn't refresh anything immediately.",
                    confirmLabel: "Queue refresh",
                  }}
                />
              )}
              {canUpdateAll && (
                <ManageForm
                  action={updateAllPluginsAction.bind(null, activeEnv)}
                  timingChoice={timingChoiceFor(updateTargets)}
                  backupChoice
                  label={`Update plugins on ${updateTargets.length} ${envWord} site${updateTargets.length === 1 ? "" : "s"}`}
                  pendingLabel="Queuing…"
                  variant="outline"
                  icon={<IconPlugins size={16} />}
                  confirm={{
                    title:
                      `Update ${pendingUpdateCount} plugin${pendingUpdateCount === 1 ? "" : "s"} across ` +
                      `${updateTargets.length} ${activeEnv} site${updateTargets.length === 1 ? "" : "s"}?`,
                    // Names the sites rather than only counting them. This
                    // writes to live WordPress installs and cannot be undone
                    // by running it again, so the reader is owed the list, not
                    // a number they have to go and reconcile.
                    description:
                      `${updateNames} — every plugin with an ` +
                      "available update will be updated on each. Plugin updates can change how a " +
                      "site behaves, and " +
                      (activeEnv === "production"
                        ? "these are live sites your clients' visitors are using right now. "
                        : "these are staging copies. ") +
                      "The work is queued and runs in the background over the next few minutes; " +
                      "you'll be taken to a page showing each site's progress.",
                    confirmLabel: "Queue updates",
                    // Production writes get the destructive treatment; the
                    // same action on staging does not, because a confirmation
                    // that is always red stops meaning anything.
                    tone: activeEnv === "production" ? "danger" : "default",
                  }}
                />
              )}
              {canHardenFleet && (
                <ManageForm
                  action={hardenFleetAction.bind(null, activeEnv)}
                  timingChoice={timingChoiceFor(hardenTargets)}
                  label={`Harden ${hardenTargets.length} ${envWord} site${hardenTargets.length === 1 ? "" : "s"}`}
                  pendingLabel="Queuing…"
                  variant="outline"
                  icon={<IconShield size={16} />}
                  confirm={{
                    title:
                      `Apply ${hardenFixCount} hardening fix${hardenFixCount === 1 ? "" : "es"} across ` +
                      `${hardenTargets.length} ${activeEnv} site${hardenTargets.length === 1 ? "" : "s"}?`,
                    description: [
                      hardenTargets.map((r) => r.site.name).join(", ") + ".",
                      "",
                      ...hardenKinds.map((f) => `• ${FIX_LABEL[f]}`),
                      "",
                      "Each fix is a small file the panel writes into wp-content and can remove again; " +
                        "nothing in wp-config.php or .htaccess is touched. Each site is rescanned afterwards. " +
                        "Queued and run in the background; you'll be taken to the progress page.",
                    ].join(String.fromCharCode(10)),
                    confirmLabel: "Queue hardening",
                    tone: activeEnv === "production" ? "danger" : "default",
                  }}
                />
              )}
              {canRefreshAll && (
                <ManageForm
                  action={setupBackupsFleetAction.bind(null, activeEnv)}
                  label={`Set up backups (${refreshTargets.length} ${envWord})`}
                  pendingLabel="Queuing…"
                  variant="outline"
                  icon={<IconUpload size={16} />}
                  confirm={{
                    title: `Set up UpdraftPlus backups on ${refreshTargets.length} ${activeEnv} site${refreshTargets.length === 1 ? "" : "s"}?`,
                    description:
                      "On each site: installs and activates UpdraftPlus from wordpress.org if it is missing, adds " +
                      "Google Drive as a backup destination (existing destinations are kept), sets weekly file and " +
                      "database backups where none are scheduled, and re-registers the schedule. Sites already set " +
                      "up are left as they are. Afterwards, Google Drive still needs one \"Sign in with Google\" per " +
                      "site as teamocsph@gmail.com, in Settings → UpdraftPlus Backups → Settings.",
                    confirmLabel: "Queue setup",
                    tone: activeEnv === "production" ? "danger" : "default",
                  }}
                />
              )}
              {canConnectSite && (
                <Link href="/sites/new" className={buttonClass("primary")}>
                  <IconPlus size={16} />
                  Connect site
                </Link>
              )}
            </>
          )
        }
      />

      {anyConnected && <FleetOverviewBand o={overview} />}

      {/* Above "Needs attention" per the spec this implements: a jobs admin
          page nobody opens does not solve invisibility, this does. Rendered
          only when there is something to report -- a permanently-present
          "System: OK" panel trains people to stop seeing it, so this section
          does not exist at all once there's nothing wrong. */}
      {showSystemHealth && (
        <section aria-labelledby="system-health" className="mb-6">
          <h2
            id="system-health"
            className="mb-2 flex items-center gap-2 text-body font-medium text-ink"
          >
            <IconAlert size={16} className="text-status-warn" />
            System health
          </h2>
          <div className="space-y-3">
            {failureGroups.map((group) => {
              const dismiss = dismissGlobalFailedJobsAction.bind(null, group.type);
              const label = JOB_TYPE_LABEL[group.type];
              return (
                <div key={group.type} className={`${cardClass} p-5`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone="bad">{group.jobs.length} failed</StatusBadge>
                      <p className="text-body font-medium text-ink">{label} did not complete</p>
                    </div>
                    <ManageForm
                      action={dismiss}
                      label="Dismiss"
                      pendingLabel="Dismissing…"
                      success="Failed jobs dismissed"
                      size="sm"
                      confirm={{
                        title: `Dismiss failed ${label.toLowerCase()} jobs?`,
                        description:
                          "This dismisses every failed run of this type, not just the one shown " +
                          "below — the jobs stay in the record for diagnosis, this only clears the alert.",
                        confirmLabel: "Dismiss",
                      }}
                    />
                  </div>
                  <p className="mt-1 break-words text-body text-mid-gray">
                    {group.latest.finished_at
                      ? `Failed ${new Date(group.latest.finished_at).toLocaleString()} — `
                      : ""}
                    {group.latest.last_error ?? "No error was recorded."}
                  </p>
                </div>
              );
            })}

            {feedStatus.state !== "fresh" && (
              <div className={`${cardClass} p-5`}>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={feedStatus.state === "never" ? "bad" : "warn"}>
                    {feedStatus.state === "never" ? "Never populated" : "Stale"}
                  </StatusBadge>
                  <p className="text-body font-medium text-ink">Vulnerability feed</p>
                </div>
                <p className="mt-1 break-words text-body text-mid-gray">{feedStatus.message}</p>
              </div>
            )}
          </div>
        </section>
      )}

      {total === 0 ? (
        <Card>
          {canConnectSite ? (
            <EmptyState
              icon={<IconSites size={28} />}
              title="No sites connected yet"
              action={
                <Link href="/sites/new" className={`${buttonClass("primary")} mt-1`}>
                  <IconPlus size={16} />
                  Connect your first site
                </Link>
              }
            >
              Connect a WordPress site running the Novamira plugin to manage its plugins and
              themes, scan it for vulnerabilities, and report on its search visibility.
            </EmptyState>
          ) : (
            <EmptyState icon={<IconSites size={28} />} title="No sites shared with you yet">
              Once someone on your team grants you access to a site, it will show up here.
            </EmptyState>
          )}
        </Card>
      ) : (
        <div className="space-y-8">
          <SiteCatalog query={query} result={{ ...directory, items: catalog }} counts={envCounts} />

          {needsAttention.length > 0 && (
            <section aria-labelledby="needs-attention">
              <h2
                id="needs-attention"
                className="mb-2 flex items-center gap-2 text-body font-medium text-ink"
              >
                <IconAlert size={16} className="text-status-warn" />
                Needs attention
              </h2>
              <ul className={`${cardClass} overflow-hidden`}>
                {needsAttention.map((row) => (
                  <AttentionRow key={row.site.id} row={row} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
