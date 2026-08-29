import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { SiteTabs } from "../tabs";
import { ManageForm } from "../action-form";
import { manageAction, refreshInventoryAction } from "../manage-actions";
import { createChildThemeAction } from "../child-theme-actions";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { Card, CardTitle, EmptyState, StatusBadge } from "@/components/ui/primitives";
import { tableCellClass, tableHeadClass, tableRowClass } from "@/components/ui/styles";
import { IconRefresh, IconThemes } from "@/components/ui/icons";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function ThemesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();
  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(id);
  const themes = snapshot?.payload.themes ?? [];
  const activeTheme = themes.find((t) => t.status === "active");

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
      <h1 className="mb-6 text-heading-sm font-semibold text-ink">{site.name}</h1>
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
        <ManageForm
          action={refresh}
          label="Refresh inventory"
          pendingLabel="Refreshing…"
          success="Inventory refreshed"
          icon={<IconRefresh size={16} />}
          showInlineError={false}
        />
      </div>

      <Card className="overflow-hidden">
        {themes.length === 0 ? (
          <EmptyState
            icon={<IconThemes size={28} />}
            title={snapshot ? "No themes installed" : "No inventory yet"}
          >
            {snapshot
              ? "This site has no themes registered."
              : "Refresh the inventory to pull the current theme list from the site."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-body">
              <thead>
                <tr className={tableHeadClass}>
                  <th className="px-5 py-3 font-medium">Theme</th>
                  <th className="px-5 py-3 font-medium">Version</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Update</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {themes.map((t) => {
                  const update = manageAction.bind(null, id, {
                    kind: "update_theme" as const, slug: t.name,
                  });
                  const name = t.title || t.name;
                  return (
                    <tr key={t.name} className={tableRowClass}>
                      <td className={`${tableCellClass} font-medium text-ink`}>{name}</td>
                      <td className={`${tableCellClass} text-mid-gray`}>{t.version}</td>
                      <td className={tableCellClass}>
                        <StatusBadge tone={t.status === "active" ? "good" : "idle"}>
                          {t.status}
                        </StatusBadge>
                      </td>
                      <td className={tableCellClass}>
                        {t.update === "available" ? (
                          <StatusBadge tone="warn">{t.update_version ?? "available"}</StatusBadge>
                        ) : (
                          <span className="text-caption tracking-normal text-mid-gray">current</span>
                        )}
                      </td>
                      <td className={tableCellClass}>
                        <div className="flex justify-end">
                          {t.update === "available" && (
                            <ManageForm
                              action={update}
                              label="Update"
                              pendingLabel="Updating…"
                              success={`${name} updated`}
                              size="sm"
                              confirm={{
                                title: `Update ${name}?`,
                                description: `Version ${t.version} will be replaced with ${t.update_version ?? "the latest release"}. If this theme has been edited directly, those changes will be lost — that is what child themes are for.`,
                                confirmLabel: "Update",
                              }}
                              showInlineError={false}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

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
              showInlineError={false}
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
              showInlineError={false}
            />
          </div>
        </div>
      </Card>
    </main>
  );
}
