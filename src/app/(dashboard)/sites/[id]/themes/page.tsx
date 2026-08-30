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
import { refreshInventoryAction } from "../manage-actions";
import { createChildThemeAction } from "../child-theme-actions";
import { ThemeTable } from "./theme-table";
import { InstallPanel } from "./install-panel";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { Card, CardTitle, EmptyState } from "@/components/ui/primitives";
import { IconRefresh, IconThemes } from "@/components/ui/icons";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function ThemesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireSiteAccess(id);
  const db = await readDbFor(viewer);
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs: supabaseJobsRepo(db) }, id);
  if (!site) notFound();
  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(id);
  const themes = snapshot?.payload.themes ?? [];
  const activeTheme = themes.find((t) => t.status === "active");

  // Final whole-branch review, finding 7: refreshInventoryAction
  // (manage-actions.ts) checks both wp_toolkit.manage and a "manage" site
  // grant -- a site grant alone (the level a client's own dashboard offers)
  // is not enough, or the button renders for a viewer the action then
  // refuses. Same fix as sites/[id]/page.tsx's canRefresh.
  const canRefresh = can(viewer, "wp_toolkit.manage") && canAccessSite(viewer, id, "manage");
  const canManageToolkit = canRefresh;

  const refresh = refreshInventoryAction.bind(null, id);
  const createChild = createChildThemeAction.bind(null, id, false);
  const createAndActivate = createChildThemeAction.bind(null, id, true);

  return (
    <main>
      <Breadcrumbs
        items={[
          { label: "Sites", href: "/dashboard" },
          { label: site.name, href: `/sites/${id}` },
          { label: "Themes" },
        ]}
      />
      <SiteHeading site={site} />
      <SiteTabs siteId={id} active="themes" />

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="text-body text-mid-gray">
          {snapshot ? (
            <>
              {themes.length} installed
              {activeTheme ? ` · ${activeTheme.title || activeTheme.name} is active` : ""}
              <span className="block text-caption tracking-normal">
                Inventory taken {new Date(snapshot.taken_at).toLocaleString()}
              </span>
            </>
          ) : (
            "No inventory yet — refresh to load themes."
          )}
        </p>
        {canRefresh && (
          <ManageForm
            action={refresh}
            label="Refresh inventory"
            pendingLabel="Refreshing…"
            success="Inventory refreshed"
            icon={<IconRefresh size={16} />}

          />
        )}
      </div>

      {!snapshot ? (
        <Card className="overflow-hidden">
          <EmptyState icon={<IconThemes size={28} />} title="No inventory yet">
            Refresh the inventory to pull the current theme list from the site.
          </EmptyState>
        </Card>
      ) : themes.length === 0 ? (
        <Card className="overflow-hidden">
          <EmptyState icon={<IconThemes size={28} />} title="No themes installed">
            This site has no themes registered.
          </EmptyState>
        </Card>
      ) : (
        <ThemeTable siteId={id} siteName={site.name} siteEnv={environmentSuffix(site)} themes={themes} canManage={canManageToolkit} />
      )}

      {canManageToolkit && (
        <div className="mt-4">
          <InstallPanel siteId={id} siteName={site.name} />
        </div>
      )}

      {canManageToolkit && (
      <Card className="mt-4">
        <CardTitle>Child theme</CardTitle>
        <div className="p-5">
          <p className="mb-4 max-w-prose text-body text-mid-gray">
            Generates a child of the active theme — a <code className="text-ink">style.css</code> and
            a <code className="text-ink">functions.php</code> that enqueues the parent stylesheet — so
            your customisations survive the parent theme&rsquo;s updates. It refuses to run if the
            active theme is already a child.
          </p>
          <div className="flex flex-wrap gap-2">
            <ManageForm
              action={createChild}
              label="Create child theme"
              pendingLabel="Creating…"
              success="Child theme created"
              confirm={{
                title: "Create a child theme?",
                description: `A child of ${activeTheme ? activeTheme.title || activeTheme.name : "the active theme"} will be written to ${site.name}. The active theme does not change.`,
                confirmLabel: "Create",
              }}

            />
            <ManageForm
              action={createAndActivate}
              label="Create and activate"
              pendingLabel="Creating…"
              success="Child theme created and activated"
              variant="primary"
              confirm={{
                title: "Create and activate a child theme?",
                description: `${site.name} will switch to the new child theme immediately. Customiser settings and widgets are per-theme in WordPress, so some may need to be set again.`,
                confirmLabel: "Create and activate",
                tone: "danger",
              }}

            />
          </div>
        </div>
      </Card>
      )}
    </main>
  );
}
