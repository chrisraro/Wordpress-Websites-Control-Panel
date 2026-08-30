import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { requireSiteAccess } from "@/lib/authz/server";
import { readDbFor } from "@/lib/authz/db";
import { can, canAccessSite } from "@/lib/authz/decide";
import { supabaseAdminUsersRepo, supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { testConnectionAction } from "./actions";
import { SiteTabs } from "./tabs";
import { StagingChip, environmentSuffix } from "./site-heading";
import { RootFilesCard } from "./root-files-card";
import { OriginOverrideForm } from "./origin-override-form";
import { siteEnvironment } from "@/services/sites/portfolio";
import { ManageForm } from "./action-form";
import { manageAction, refreshInventoryAction, setEnvironmentAction } from "./manage-actions";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { Card, CardTitle, EmptyState, StatusBadge, type StatusTone } from "@/components/ui/primitives";
import { buttonClass, cardClass } from "@/components/ui/styles";
import { CopyValueButton } from "@/components/ui/copy-button";
import { IconChevronRight, IconExternal, IconRefresh, IconUsers } from "@/components/ui/icons";
import type { SiteStatus } from "@/services/sites/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STATUS_TONE: Record<SiteStatus, StatusTone> = {
  connected: "good", degraded: "warn", reconnect_needed: "bad", disabled: "idle",
};

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireSiteAccess(id);
  const db = await readDbFor(viewer);
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs: supabaseJobsRepo(db) }, id);
  if (!site) notFound();

  const canTestConnection = can(viewer, "sites.manage");
  // refreshInventoryAction (manage-actions.ts) checks both wp_toolkit.manage
  // and a "manage" site grant -- a `manage` grant alone (the level a
  // client's own dashboard offers) is not enough. canRefresh has to mirror
  // both checks, or the button renders for a viewer the action then refuses.
  const canRefresh = can(viewer, "wp_toolkit.manage") && canAccessSite(viewer, id, "manage");
  // manageAction (manage-actions.ts) requires this identical pair --
  // wp_toolkit.manage plus a "manage" site grant -- so canManageToolkit is
  // deliberately the same value as canRefresh, not an independent
  // computation that happens to match today. If manageAction's checks ever
  // diverge from refreshInventoryAction's, this must be split back into its
  // own `can(viewer, "wp_toolkit.manage") && canAccessSite(viewer, id, "manage")`
  // rather than continuing to alias canRefresh.
  const canManageToolkit = canRefresh;

  // site_admin_users' RLS policy (0011_site_admin_users.sql), the sites
  // table's credential-adjacent columns (spec §5.2), and activity_log's RLS
  // policy (0008_rls_scoped.sql:197-199) all gate their real read on
  // sites.view_all, not on "is this viewer a client" -- those only coincide
  // under today's seeded permission matrix. `db` here is already the
  // service-role client (readDbFor returns it for any non-client viewer),
  // which bypasses RLS entirely, so every read below that has a matching
  // RLS policy has to re-check the same permission that policy checks --
  // not stand in a role check (e.g. "is this viewer a client"), which stops
  // matching the moment an admin edits the matrix (this phase ships that
  // editor) and would then keep serving this data to a role the database
  // itself would refuse. This page no longer has any role-based gate at
  // all -- the "Open wp-admin" link was the last one, see below.
  const canViewAdminUsers = can(viewer, "sites.view_all");

  // mcp_endpoint and wp_username are credential-adjacent (spec §5.2) and are
  // off SITE_COLUMNS/SiteRow entirely -- getSite above never carries them.
  const connection = canViewAdminUsers ? await supabaseSitesRepo(db).getSiteConnection(id) : null;

  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(id);
  const inv = snapshot?.payload ?? null;
  const adminUsers = canViewAdminUsers ? await supabaseAdminUsersRepo(db).latestAdminUsers(id) : null;

  // See the canViewAdminUsers comment above: activity_log's RLS policy
  // requires sites.view_all, and this read runs on the service-role client,
  // which never consults that policy at all.
  const { data: activity } = canViewAdminUsers
    ? await db
        .from("activity_log")
        .select("action,detail,at")
        .eq("site_id", id)
        .order("at", { ascending: false })
        .limit(10)
    : { data: null };

  const testConnection = testConnectionAction.bind(null, id);
  const refresh = refreshInventoryAction.bind(null, id);
  const updateCore = manageAction.bind(null, id, { kind: "update_core" as const });
  const maintenanceOn = manageAction.bind(null, id, { kind: "maintenance" as const, enable: true });
  const maintenanceOff = manageAction.bind(null, id, { kind: "maintenance" as const, enable: false });
  const flushCache = manageAction.bind(null, id, { kind: "flush_cache" as const });
  const flushPermalinks = manageAction.bind(null, id, { kind: "flush_permalinks" as const });
  const environment = siteEnvironment(site);
  // Flips to the other one; the button label and confirm say which.
  const flipEnvironment = setEnvironmentAction.bind(
    null, id, environment === "staging" ? "production" : "staging",
  );

  return (
    <main>
      <Breadcrumbs items={[{ label: "Sites", href: "/dashboard" }, { label: site.name }]} />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="break-words text-heading-sm font-semibold text-ink">{site.name}</h1>
            <StagingChip site={site} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <StatusBadge tone={STATUS_TONE[site.status]}>
              {site.status.replace("_", " ")}
            </StatusBadge>
            <a
              href={site.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 break-all text-body text-mid-gray underline
                transition-colors duration-150 hover:text-ink"
            >
              {site.url.replace(/^https?:\/\//, "")}
              <IconExternal size={14} className="shrink-0" />
            </a>
            {inv && (
              <span className="text-body text-mid-gray">
                WP {inv.wp_version} · PHP {inv.php_version}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-start gap-2">
            {canRefresh && (
              <ManageForm
                action={refresh}
                label="Refresh inventory"
                pendingLabel="Refreshing…"
                success="Inventory refreshed"
                icon={<IconRefresh size={16} />}

              />
            )}
            {canTestConnection && (
              <ManageForm
                action={testConnection}
                label="Test connection"
                pendingLabel="Testing…"
                success="Connection is healthy"

              />
            )}
            {canViewAdminUsers && (
              <a
                href={inv?.admin_url ?? `${site.url.replace(/\/+$/, "")}/wp-admin/`}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClass("outline")}
              >
                <IconExternal size={16} />
                Open wp-admin
              </a>
            )}
          </div>
          {connection && (
            <>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <CopyValueButton value={connection.wp_username} label="Copy WP username" />
              </div>
              <p className="max-w-72 text-right text-caption tracking-normal text-mid-gray">
                Application passwords can’t sign in to wp-admin — sign in with your usual WordPress
                password once there.
              </p>
            </>
          )}
        </div>
      </div>

      <SiteTabs siteId={id} active="overview" />

      {/* Above every other banner on the page, including the core update.
          A site behind a maintenance page is not serving its visitors right
          now, which outranks anything else this page has to say about it. */}
      {inv?.maintenance === true && (
        <div
          className={`${cardClass} mb-6 flex flex-wrap items-center justify-between gap-4 p-5`}
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="bad">Maintenance mode</StatusBadge>
              <p className="text-body font-medium text-ink">
                Visitors can’t reach this site
              </p>
            </div>
            <p className="mt-1 text-body text-mid-gray">
              {site.name} is showing a maintenance page to everyone. It stays that way until
              maintenance mode is turned off.
            </p>
          </div>
          {canManageToolkit && (
            <ManageForm
              action={maintenanceOff}
              label="Turn maintenance off"
              pendingLabel="Disabling…"
              success="Site is live again"
              variant="primary"
            />
          )}
        </div>
      )}

      {inv?.core_update && (
        <div className={`${cardClass} mb-6 flex flex-wrap items-center justify-between gap-4 p-5`}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="warn">Update available</StatusBadge>
              <p className="text-body font-medium text-ink">WordPress {inv.core_update}</p>
            </div>
            <p className="mt-1 text-body text-mid-gray">
              This site is running {inv.wp_version}.
            </p>
          </div>
          {canManageToolkit && (
            <ManageForm
              action={updateCore}
              label="Update core"
              pendingLabel="Updating…"
              success={`WordPress updated to ${inv.core_update}`}
              variant="primary"
              confirm={{
                title: `Update WordPress core on ${site.name}${environmentSuffix(site)}?`,
                description: `${site.name} will be updated from ${inv.wp_version} to ${inv.core_update}. The site goes into maintenance mode during the update. Take a backup first if you are unsure.`,
                confirmLabel: "Update core",
              }}

            />
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>Connection</CardTitle>
          <dl className="divide-y divide-hairline px-5 text-body">
            {[
              ...(connection ? [{ term: "MCP endpoint", value: connection.mcp_endpoint, truncate: true }] : []),
              ...(connection ? [{ term: "WP user", value: connection.wp_username }] : []),
              { term: "Abilities", value: String(site.capabilities?.abilities?.length ?? 0) },
              { term: "Connected", value: new Date(site.created_at).toLocaleDateString() },
              ...(snapshot
                ? [{ term: "Inventory", value: new Date(snapshot.taken_at).toLocaleString() }]
                : []),
            ].map((row) => (
              <div key={row.term} className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="shrink-0 text-mid-gray">{row.term}</dt>
                <dd
                  className={row.truncate ? "min-w-0 truncate text-ink" : "text-ink"}
                  title={row.truncate ? row.value : undefined}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>

          {/* Environment sits in the site's own record, beside the other
              facts about the connection, because that is what it is -- and
              because it must be correctable. The twelve existing rows were
              backfilled by a regex (0017) and bulk imports still get the
              regex's answer, so a wrong label has to be fixable here rather
              than in a database console. Changing it changes every
              confirmation dialog on every tab, so it carries a confirm of
              its own. */}
          {canTestConnection && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-5 py-3">
              <div className="min-w-0">
                <p className="text-body text-mid-gray">Environment</p>
                <p className="text-body text-ink">
                  {environment === "staging" ? "Staging" : "Production"}
                </p>
              </div>
              <ManageForm
                action={flipEnvironment}
                size="sm"
                label={environment === "staging" ? "Mark as production" : "Mark as staging"}
                pendingLabel="Saving…"
                success={
                  environment === "staging"
                    ? `${site.name} is now marked production`
                    : `${site.name} is now marked staging`
                }
                confirm={{
                  title:
                    environment === "staging"
                      ? `Mark ${site.name} as production?`
                      : `Mark ${site.name} as staging?`,
                  description:
                    environment === "staging"
                      ? `${site.name} will stop showing the STAGING chip, and confirmations before destructive actions will no longer warn that it is a copy. Only do this if it really is the live site.`
                      : `${site.name} will be marked STAGING everywhere, including in every confirmation before an action runs.`,
                  confirmLabel: environment === "staging" ? "Mark as production" : "Mark as staging",
                  tone: environment === "staging" ? "danger" : "default",
                }}
              />
            </div>
          )}

          {/* Direct-to-origin override. Lives beside the other connection
              facts because that is what it is: how this panel reaches the
              site. Only offered to someone who can already manage the site
              record, and only when the credential-adjacent connection block
              is visible -- these two values describe a route past the CDN
              and belong with mcp_endpoint, not on a page a client can see. */}
          {canTestConnection && connection && (
            <OriginOverrideForm
              siteId={id}
              siteName={site.name}
              originIp={connection.origin_ip ?? null}
              originSni={connection.origin_sni ?? null}
            />
          )}

          <details className="group border-t border-hairline px-5 py-3">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-body text-mid-gray transition-colors duration-150 hover:text-ink">
              <IconChevronRight
                size={14}
                className="shrink-0 transition-transform duration-200 ease-[var(--ease-out-quint)] group-open:rotate-90"
              />
              All abilities
            </summary>
            <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto text-caption tracking-normal text-mid-gray">
              {(site.capabilities?.abilities ?? []).map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </details>
        </Card>

        {canViewAdminUsers && (
        <Card>
          <CardTitle>Recent activity</CardTitle>
          {!activity?.length ? (
            <p className="px-5 py-6 text-body text-mid-gray">
              Actions you take on this site will be listed here.
            </p>
          ) : (
            <ul className="divide-y divide-hairline px-5">
              {activity.map((a, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 py-2.5 text-body">
                  <span className="min-w-0 truncate text-ink">{a.action}</span>
                  <span className="shrink-0 text-caption tracking-normal text-mid-gray">
                    {new Date(a.at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        )}

        {canManageToolkit && (
        <Card>
          <CardTitle>Tools</CardTitle>
          <div className="flex flex-wrap gap-2 p-5">
            {/* One control that reflects the current state, not two blind
                buttons. Maintenance mode puts a client's live site behind a
                maintenance page for its visitors, and nothing in the panel
                used to report that it was still on -- a site could be left
                down indefinitely with the panel showing no trace of it.
                `undefined` means the snapshot predates the field, so the
                offer stays "turn it on" and the state line says so rather
                than claiming the site is live. */}
            {inv?.maintenance === true ? (
              <ManageForm
                action={maintenanceOff}
                label="Turn maintenance off"
                pendingLabel="Disabling…"
                success="Site is live again"
                variant="primary"
              />
            ) : (
              <ManageForm
                action={maintenanceOn}
                label="Maintenance on"
                pendingLabel="Enabling…"
                success="Maintenance mode is on"
                confirm={{
                  title: `Put ${site.name}${environmentSuffix(site)} into maintenance mode?`,
                  description: `Visitors to ${site.name} will see a maintenance page until you turn it off. Nothing else on the site changes.`,
                  confirmLabel: "Enable maintenance",
                  tone: "danger",
                }}
              />
            )}
            <ManageForm
              action={flushCache}
              label="Flush cache"
              pendingLabel="Flushing…"
              success="Object cache flushed"

            />
            <ManageForm
              action={flushPermalinks}
              label="Flush permalinks"
              pendingLabel="Flushing…"
              success="Rewrite rules flushed"

            />
          </div>
        </Card>
        )}

        {/* Same gate as Tools: this writes to the live filesystem, so it needs
            wp_toolkit.manage plus a per-site manage grant, which is what
            canManageToolkit already resolves to. */}
        {canManageToolkit && (
          <RootFilesCard
            siteId={id}
            siteName={site.name}
            siteEnv={environmentSuffix(site)}
          />
        )}

        {canViewAdminUsers && (
        <Card>
          <CardTitle>Administrators</CardTitle>
          {!adminUsers?.users.length ? (
            <EmptyState
              icon={<IconUsers size={28} />}
              title="No administrator data collected yet"
              action={
                canRefresh ? (
                  <ManageForm
                    action={refresh}
                    label="Refresh inventory"
                    pendingLabel="Refreshing…"
                    success="Inventory refreshed"
                    icon={<IconRefresh size={16} />}

                  />
                ) : undefined
              }
            >
              Refresh the inventory to collect this site&rsquo;s administrator accounts.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-hairline px-5">
              {adminUsers.users.map((u) => (
                <li key={u.ID} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5 text-body">
                  <span className="font-medium text-ink">{u.user_login}</span>
                  <span className="min-w-0 truncate text-mid-gray">{u.user_email}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        )}
      </div>
    </main>
  );
}
