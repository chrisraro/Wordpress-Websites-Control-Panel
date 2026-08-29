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
import { siteAttention, isStaging, SEVERITY_RANK, type Severity } from "@/services/sites/portfolio";
import type { SiteRow } from "@/services/sites/types";
import { Card, EmptyState, PageHeader, StatusBadge, type StatusTone } from "@/components/ui/primitives";
import { badgeClass, buttonClass, cardClass } from "@/components/ui/styles";
import { IconAlert, IconCheck, IconChevronRight, IconPlus, IconRefresh, IconSites } from "@/components/ui/icons";
import { ManageForm } from "../sites/[id]/action-form";
import { refreshAllInventoryAction } from "./actions";

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
        </div>

        {/* The two sections carry different information, so they show
            different things. A row that needs attention states its problems in
            words; repeating "2 updates" as a badge beside "2 updates pending"
            says it twice and reads as two separate facts. A healthy row has no
            problems to state, so the metrics are what there is to show. */}
        {!showReasons && (
          <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
            {updates !== undefined && updates > 0 && (
              <StatusBadge tone="warn">{updates}&nbsp;updates</StatusBadge>
            )}
            {grade && <StatusBadge tone={GRADE_TONE[grade] ?? "idle"}>Security&nbsp;{grade}</StatusBadge>}
            {seo !== undefined && <StatusBadge tone={seoTone(seo)}>SEO&nbsp;{seo}</StatusBadge>}
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

export default async function DashboardPage() {
  const viewer = await requireViewer();
  const db = await readDbFor(viewer);
  const sites = await listSitesForViewer(
    { repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs: supabaseJobsRepo(db) },
    viewer,
  );
  const canConnectSite = can(viewer, "sites.manage");

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
        staging: isStaging(site),
        severity,
        reasons,
        updates,
        grade,
        seo: score ?? undefined,
      };
    }),
  );

  const byName = (a: Row, b: Row) => a.site.name.localeCompare(b.site.name);
  const needsAttention = rows
    .filter((r) => r.severity !== "ok")
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || byName(a, b));
  const healthy = rows.filter((r) => r.severity === "ok").sort(byName);

  const total = sites.length;
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
                  showInlineError={false}
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
