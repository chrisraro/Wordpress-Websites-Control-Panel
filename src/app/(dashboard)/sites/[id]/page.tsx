import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { requireSiteAccess } from "@/lib/authz/server";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { testConnectionAction } from "./actions";
import { SiteTabs } from "./tabs";
import { ManageForm } from "./action-form";
import { manageAction, refreshInventoryAction } from "./manage-actions";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { Card, CardTitle, StatusBadge, type StatusTone } from "@/components/ui/primitives";
import { buttonClass, cardClass } from "@/components/ui/styles";
import { CopyValueButton } from "@/components/ui/copy-button";
import { IconChevronRight, IconExternal, IconRefresh } from "@/components/ui/icons";
import type { SiteStatus } from "@/services/sites/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STATUS_TONE: Record<SiteStatus, StatusTone> = {
  connected: "good", degraded: "warn", reconnect_needed: "bad", disabled: "idle",
};

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSiteAccess(id);
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();

  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(id);
  const inv = snapshot?.payload ?? null;

  const { data: activity } = await db
    .from("activity_log")
    .select("action,detail,at")
    .eq("site_id", id)
    .order("at", { ascending: false })
    .limit(10);

  const testConnection = testConnectionAction.bind(null, id);
  const refresh = refreshInventoryAction.bind(null, id);
  const updateCore = manageAction.bind(null, id, { kind: "update_core" as const });
  const maintenanceOn = manageAction.bind(null, id, { kind: "maintenance" as const, enable: true });
  const maintenanceOff = manageAction.bind(null, id, { kind: "maintenance" as const, enable: false });
  const flushCache = manageAction.bind(null, id, { kind: "flush_cache" as const });
  const flushPermalinks = manageAction.bind(null, id, { kind: "flush_permalinks" as const });

  return (
    <main>
      <Breadcrumbs items={[{ label: "Sites", href: "/dashboard" }, { label: site.name }]} />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-heading-sm font-semibold text-ink">{site.name}</h1>
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
            <ManageForm
              action={refresh}
              label="Refresh inventory"
              pendingLabel="Refreshing…"
              success="Inventory refreshed"
              icon={<IconRefresh size={16} />}
              showInlineError={false}
            />
            <ManageForm
              action={testConnection}
              label="Test connection"
              pendingLabel="Testing…"
              success="Connection is healthy"
              showInlineError={false}
            />
            <a
              href={inv?.admin_url ?? `${site.url.replace(/\/+$/, "")}/wp-admin/`}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass("outline")}
            >
              <IconExternal size={16} />
              Open wp-admin
            </a>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <CopyValueButton value={site.wp_username} label="Copy WP username" />
          </div>
          <p className="max-w-72 text-right text-caption tracking-normal text-mid-gray">
            Application passwords can’t sign in to wp-admin — sign in with your usual WordPress
            password once there.
          </p>
        </div>
      </div>

      <SiteTabs siteId={id} active="overview" />

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
          <ManageForm
            action={updateCore}
            label="Update core"
            pendingLabel="Updating…"
            success={`WordPress updated to ${inv.core_update}`}
            variant="primary"
            confirm={{
              title: "Update WordPress core?",
              description: `${site.name} will be updated from ${inv.wp_version} to ${inv.core_update}. The site goes into maintenance mode during the update. Take a backup first if you are unsure.`,
              confirmLabel: "Update core",
            }}
            showInlineError={false}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>Connection</CardTitle>
          <dl className="divide-y divide-hairline px-5 text-body">
            {[
              { term: "MCP endpoint", value: site.mcp_endpoint, truncate: true },
              { term: "WP user", value: site.wp_username },
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

        <Card>
          <CardTitle>Tools</CardTitle>
          <div className="flex flex-wrap gap-2 p-5">
            <ManageForm
              action={maintenanceOn}
              label="Maintenance on"
              pendingLabel="Enabling…"
              success="Maintenance mode is on"
              confirm={{
                title: "Put the site into maintenance mode?",
                description: `Visitors to ${site.name} will see a maintenance page until you turn it off.`,
                confirmLabel: "Enable maintenance",
                tone: "danger",
              }}
              showInlineError={false}
            />
            <ManageForm
              action={maintenanceOff}
              label="Maintenance off"
              pendingLabel="Disabling…"
              success="Site is live again"
              showInlineError={false}
            />
            <ManageForm
              action={flushCache}
              label="Flush cache"
              pendingLabel="Flushing…"
              success="Object cache flushed"
              showInlineError={false}
            />
            <ManageForm
              action={flushPermalinks}
              label="Flush permalinks"
              pendingLabel="Flushing…"
              success="Rewrite rules flushed"
              showInlineError={false}
            />
          </div>
        </Card>

        <Card>
          <CardTitle>Administrators</CardTitle>
          {!inv?.admin_users?.length ? (
            <p className="px-5 py-6 text-body text-mid-gray">
              Refresh the inventory to list administrator accounts.
            </p>
          ) : (
            <ul className="divide-y divide-hairline px-5">
              {inv.admin_users.map((u) => (
                <li key={u.ID} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5 text-body">
                  <span className="font-medium text-ink">{u.user_login}</span>
                  <span className="min-w-0 truncate text-mid-gray">{u.user_email}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
}
