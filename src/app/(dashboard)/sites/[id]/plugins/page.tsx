import Link from "next/link";
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { requireSiteAccess } from "@/lib/authz/server";
import { readDbFor } from "@/lib/authz/db";
import { can, canAccessSite } from "@/lib/authz/decide";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { SiteTabs } from "../tabs";
import { SiteHeading, environmentSuffix } from "../site-heading";
import { ManageForm } from "../action-form";
import { manageAction, refreshInventoryAction } from "../manage-actions";
import { PluginTable } from "./plugin-table";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { Card, EmptyState } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { IconPlugins, IconPlus, IconRefresh } from "@/components/ui/icons";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function PluginsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireSiteAccess(id);
  const db = await readDbFor(viewer);
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs: supabaseJobsRepo(db) }, id);
  if (!site) notFound();
  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(id);
  const plugins = snapshot?.payload.plugins ?? [];
  const updatable = plugins.filter((p) => p.update === "available");
  const active = plugins.filter((p) => p.status === "active").length;

  // Final whole-branch review, finding 7: refreshInventoryAction
  // (manage-actions.ts) checks both wp_toolkit.manage and a "manage" site
  // grant -- a site grant alone (the level a client's own dashboard offers)
  // is not enough, or the button renders for a viewer the action then
  // refuses. Same fix as sites/[id]/page.tsx's canRefresh.
  const canRefresh = can(viewer, "wp_toolkit.manage") && canAccessSite(viewer, id, "manage");
  const canManageToolkit = canRefresh;

  const refresh = refreshInventoryAction.bind(null, id);
  const updateAll = manageAction.bind(null, id, { kind: "update_all_plugins" as const });

  return (
    <main>
      <Breadcrumbs
        items={[
          { label: "Sites", href: "/dashboard" },
          { label: site.name, href: `/sites/${id}` },
          { label: "Plugins" },
        ]}
      />
      <SiteHeading site={site} />
      <SiteTabs siteId={id} active="plugins" />

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="text-body text-mid-gray">
          {snapshot
            ? `${plugins.length} installed · ${active} active · ${updatable.length} with updates`
            : "No inventory yet — refresh to load plugins."}
          {snapshot && (
            <span className="block text-caption tracking-normal">
              Inventory taken {new Date(snapshot.taken_at).toLocaleString()}
            </span>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {canManageToolkit && (
            <Link href="/marketplace" className={buttonClass("outline")}>
              <IconPlus size={16} />
              Install plugin
            </Link>
          )}
          {canRefresh && (
            <ManageForm
              action={refresh}
              label="Refresh inventory"
              pendingLabel="Refreshing…"
              success="Inventory refreshed"
              icon={<IconRefresh size={16} />}

            />
          )}
          {canManageToolkit && updatable.length > 0 && (
            <ManageForm
              action={updateAll}
              label={`Update all (${updatable.length})`}
              pendingLabel="Updating…"
              success={`${updatable.length} plugin${updatable.length === 1 ? "" : "s"} updated`}
              variant="primary"
              confirm={{
                title: `Update ${updatable.length} plugin${updatable.length === 1 ? "" : "s"} on ${site.name}${environmentSuffix(site)}?`,
                description: `Every plugin with an available update on ${site.name} will be updated in one pass. Plugin updates can change how the site behaves — take a backup if you are unsure.`,
                confirmLabel: "Update all",
              }}

            />
          )}
        </div>
      </div>

      {!snapshot ? (
        <Card className="overflow-hidden">
          <EmptyState icon={<IconPlugins size={28} />} title="No inventory yet">
            Refresh the inventory to pull the current plugin list from the site.
          </EmptyState>
        </Card>
      ) : plugins.length === 0 ? (
        <Card className="overflow-hidden">
          <EmptyState icon={<IconPlugins size={28} />} title="No plugins installed">
            Install one from the Marketplace to get started.
          </EmptyState>
        </Card>
      ) : (
        <PluginTable siteId={id} siteName={site.name} siteEnv={environmentSuffix(site)} plugins={plugins} canManage={canManageToolkit} />
      )}
    </main>
  );
}
