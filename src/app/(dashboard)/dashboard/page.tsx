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
import { pendingUpdates } from "@/services/inventory/types";
import {
  siteAttention, isStagingSite, siteEnvironment, SEVERITY_RANK, type Severity,
} from "@/services/sites/portfolio";
import type { SiteEnvironment } from "@/services/sites/types";
import { ClientHome } from "./client-home";
import { EnvTabs } from "./env-tabs";
import type { SiteRow } from "@/services/sites/types";
import { JOB_TYPE_LABEL, type JobRow, type JobType } from "@/services/jobs/types";
import { vulnFeedStatus } from "@/services/security/scan";
import { Card, EmptyState, PageHeader, StatusBadge, type StatusTone } from "@/components/ui/primitives";
import { badgeClass, buttonClass, cardClass } from "@/components/ui/styles";
import { IconAlert, IconCheck, IconChevronRight, IconPlus, IconRefresh, IconSites } from "@/components/ui/icons";
import { ManageForm } from "../sites/[id]/action-form";
import { refreshAllInventoryAction, dismissGlobalFailedJobsAction } from "./actions";

export const dynamic = "force-dynamic";

const GRADE_TONE: Record<string, StatusTone> = {
  A: "good", B: "good", C: "warn", D: "alert", F: "bad",
};

function seoTone(score: number): StatusTone {
  return score >= 80 ? "good" : score >= 50 ? "warn" : "bad";
}

const SEVERITY_TONE: Record<Exclude<Severity, "ok">, StatusTone> = {
  critical: "bad",
  warn: "warn",
};

interface Row {
  site: SiteRow;
  staging: boolean;
  severity: Severity;
  reasons: string[];
  updates?: number;
  grade?: string;
  seo?: number;
}

/**
 * One site, as a row rather than a card.
 *
 * A grid of same-size cards makes the reader scan every tile to find the one
 * that matters; rows in a single container scan in one pass down the left
 * edge, which is what a portfolio sweep actually needs.
 */
/**
 * One definition, rendered twice: once stacked inside the text column below
 * `sm`, once as a right-hand cluster above it. Two copies of the badge list
 * would drift the moment a metric is added.
 */
function MetricBadges({
  updates, grade, seo,
}: { updates?: number; grade?: string; seo?: number }) {
  return (
    <>
      {updates !== undefined && updates > 0 && (
        <StatusBadge tone="warn">
          {updates}&nbsp;update{updates === 1 ? "" : "s"}
        </StatusBadge>
      )}
      {grade && <StatusBadge tone={GRADE_TONE[grade] ?? "idle"}>Security&nbsp;{grade}</StatusBadge>}
      {seo !== undefined && <StatusBadge tone={seoTone(seo)}>SEO&nbsp;{seo}</StatusBadge>}
    </>
  );
}

function SiteRowItem({ row, showReasons }: { row: Row; showReasons: boolean }) {
  const { site, staging, severity, reasons, updates, grade, seo } = row;
  return (
    <li className="border-b border-hairline last:border-0">
      <Link
        href={`/sites/${site.id}`}
        className="group flex items-start gap-3 px-5 py-4 transition-colors duration-150
          hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-2
          focus-visible:-outline-offset-2 focus-visible:outline-ink sm:items-center"
      >
        <span
          aria-hidden
          className={`mt-1.5 size-2 shrink-0 rounded-full sm:mt-0 ${
            severity === "critical"
              ? "bg-status-bad"
              : severity === "warn"
                ? "bg-status-warn"
                : site.status === "disabled"
                  ? "bg-mid-gray"
                  : "bg-status-good"
          }`}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-body font-medium text-ink">{site.name}</span>
            {/* Environment is marked, never inferred as production.
                Deliberately not a StatusBadge: status colour means health, and
                an environment is a category, not a health state — so this is
                the one solid chip on the page, which also makes it the loudest
                thing in the row without spending a hue the design system
                reserves for data. PRODUCT.md names acting on the wrong
                environment as the expensive mistake this product can cause;
                a quiet outline was legible but not unmissable. */}
            {staging && (
              <span className={badgeClass("solid", "uppercase tracking-[0.08em]")}>
                Staging
              </span>
            )}
            {site.status === "disabled" && <StatusBadge tone="idle">Disabled</StatusBadge>}
          </div>

          <p className="truncate text-caption tracking-normal text-mid-gray">
            {site.url.replace(/^https?:\/\//, "")}
            {site.client_label && ` · ${site.client_label}`}
          </p>

          {showReasons && reasons.length > 0 && (
            <ul className="mt-2 space-y-1">
              {reasons.map((r) => (
                <li
                  key={r}
                  className={`text-caption tracking-normal ${
                    severity === "critical" ? "text-status-bad" : "text-status-warn"
                  }`}
                >
                  {r}
                </li>
              ))}
            </ul>
          )}

          {/* Below `sm` the metrics move onto their own line inside the text
              column rather than disappearing. They used to be `hidden
              sm:flex`, which meant a healthy row on a phone was a name, a URL
              and a chevron -- and PRODUCT.md makes phone use a primary
              target, with the portfolio sweep the job most likely to happen
              there. That was a viewport escape hatch in a codebase which
              otherwise refuses them: see `pointer-coarse` in styles.ts, which
              keys on input device rather than width for exactly this reason. */}
          {!showReasons && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:hidden">
              <MetricBadges updates={updates} grade={grade} seo={seo} />
            </div>
          )}
        </div>

        {/* The two sections carry different information, so they show
            different things. A row that needs attention states its problems in
            words; repeating "2 updates" as a badge beside "2 updates pending"
            says it twice and reads as two separate facts. A healthy row has no
            problems to state, so the metrics are what there is to show. */}
        {!showReasons && (
          <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
            <MetricBadges updates={updates} grade={grade} seo={seo} />
          </div>
        )}

        <IconChevronRight
          size={16}
          className="mt-0.5 shrink-0 text-mid-gray transition-transform duration-150
            group-hover:translate-x-0.5 sm:mt-0"
        />
      </Link>
    </li>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string }>;
}) {
  // Production is the default because it is what a client's visitors see:
  // opening on staging would make the consequential half of the portfolio the
  // one you have to go looking for.
  const params = await searchParams;
  const activeEnv: SiteEnvironment = params.env === "staging" ? "staging" : "production";
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
    const clientRows = await Promise.all(
      sites.map(async (site) => {
        const snap = await supabaseSnapshotsRepo(db).latestSnapshot(site.id);
        const updates = snap ? pendingUpdates(snap.payload) : undefined;
        const grade = (await supabaseSecurityRepo(db).latestGrade(site.id))?.grade;
        return {
          site,
          severity: siteAttention({ status: site.status, updates, grade }).severity,
          // null means never measured, and ClientHome must keep that
          // distinct from healthy -- this audience is the least able to tell
          // the difference (PRODUCT.md principle 4).
          lastCheckedIso: snap?.taken_at ?? null,
        };
      }),
    );
    return <ClientHome rows={clientRows} now={Date.now()} />;
  }

  // refreshAllInventoryAction (./actions.ts) checks both wp_toolkit.manage
  // and, per site, a "manage" grant -- the same pair refreshInventoryAction
  // (../sites/[id]/manage-actions.ts) enforces for a single site. This has
  // to mirror both checks and the "skip disabled sites" rule the nightly
  // fan-out uses (src/app/api/cron/enqueue/route.ts), or the button renders
  // (or promises a count) the action would not actually honour.
  const refreshTargets = sites.filter(
    (s) => s.status !== "disabled" && canAccessSite(viewer, s.id, "manage"),
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

  // One pass per site, all in flight together. Deliberately the same four
  // reads the previous version made: this page is the landing screen and has
  // to stay fast on a phone, so the improvement here is what the data is
  // arranged into, not how much more of it is fetched.
  const rows: Row[] = await Promise.all(
    sites.map(async (site) => {
      const [snap, g, score] = await Promise.all([
        snapshots.latestSnapshot(site.id),
        securityRepo.latestGrade(site.id),
        seoRepo.latestAuditScore(site.id),
      ]);
      const updates = snap ? pendingUpdates(snap.payload) : undefined;
      const grade = g?.grade;
      const { severity, reasons } = siteAttention({ status: site.status, updates, grade });
      return {
        site,
        staging: isStagingSite(site),
        severity,
        reasons,
        updates,
        grade,
        seo: score ?? undefined,
      };
    }),
  );

  const byName = (a: Row, b: Row) => a.site.name.localeCompare(b.site.name);

  // Counts for BOTH tabs are computed before filtering, so the tab you are
  // not looking at can still report what needs attention. Without this the
  // split would hide exceptions rather than organise them.
  const countsFor = (env: SiteEnvironment) => {
    const inEnv = rows.filter((r) => siteEnvironment(r.site) === env);
    return { total: inEnv.length, needsAttention: inEnv.filter((r) => r.severity !== "ok").length };
  };
  const envCounts = { production: countsFor("production"), staging: countsFor("staging") };

  const visible = rows.filter((r) => siteEnvironment(r.site) === activeEnv);
  const needsAttention = visible
    .filter((r) => r.severity !== "ok")
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || byName(a, b));
  const healthy = visible.filter((r) => r.severity === "ok").sort(byName);

  // Scoped to the visible tab: a subtitle counting the whole fleet beside a
  // list showing half of it is a subtitle nobody can reconcile.
  const total = visible.length;
  const subtitle =
    total === 0
      ? undefined
      : needsAttention.length > 0
        ? `${needsAttention.length} of ${total} ${total === 1 ? "site needs" : "sites need"} attention`
        : `All ${total} ${total === 1 ? "site is" : "sites are"} healthy`;

  return (
    <main>
      <PageHeader
        title="Sites"
        subtitle={subtitle}
        actions={
          total > 0 && (
            <>
              {canRefreshAll && (
                <ManageForm
                  action={refreshAllInventoryAction}
                  label="Refresh all inventory"
                  pendingLabel="Queuing…"
                  variant="outline"
                  icon={<IconRefresh size={16} />}

                  confirm={{
                    title: `Refresh inventory for ${refreshTargets.length} site${refreshTargets.length === 1 ? "" : "s"}?`,
                    description:
                      `This queues a fresh inventory scan for ${refreshTargets.length} ` +
                      `site${refreshTargets.length === 1 ? "" : "s"} — each one means connecting to the live ` +
                      "WordPress install and running code there. Jobs run in the background over the next " +
                      "minute or so; this doesn't refresh anything immediately.",
                    confirmLabel: "Queue refresh",
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

      <EnvTabs
        active={activeEnv}
        production={envCounts.production}
        staging={envCounts.staging}
      />

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
        <div className="space-y-6">
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
                  <SiteRowItem key={row.site.id} row={row} showReasons />
                ))}
              </ul>
            </section>
          )}

          {/* Omitted entirely when every site is already listed above. A
              section that renders only to announce it is empty is noise on the
              screen someone opens to find what needs doing. */}
          {healthy.length > 0 && (
            <section aria-labelledby="all-sites">
              <h2
                id="all-sites"
                className="mb-2 flex items-center gap-2 text-body font-medium text-ink"
              >
                {needsAttention.length === 0 && <IconCheck size={16} className="text-status-good" />}
                {needsAttention.length > 0 ? "Everything else" : "All sites"}
              </h2>
              <ul className={`${cardClass} overflow-hidden`}>
                {healthy.map((row) => (
                  <SiteRowItem key={row.site.id} row={row} showReasons={false} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
