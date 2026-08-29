import Link from "next/link";
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { SiteTabs } from "../tabs";
import { ManageForm } from "../action-form";
import { manageAction, refreshInventoryAction } from "../manage-actions";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { Card, EmptyState, StatusBadge } from "@/components/ui/primitives";
import { buttonClass, tableCellClass, tableHeadClass, tableRowClass } from "@/components/ui/styles";
import { IconPlugins, IconPlus, IconRefresh } from "@/components/ui/icons";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function PluginsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();
  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(id);
  const plugins = snapshot?.payload.plugins ?? [];
  const updatable = plugins.filter((p) => p.update === "available");
  const active = plugins.filter((p) => p.status === "active").length;

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
      <h1 className="mb-6 text-heading-sm font-semibold text-ink">{site.name}</h1>
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
          <Link href="/marketplace" className={buttonClass("outline")}>
            <IconPlus size={16} />
            Install plugin
          </Link>
          <ManageForm
            action={refresh}
            label="Refresh inventory"
            pendingLabel="Refreshing…"
            success="Inventory refreshed"
            icon={<IconRefresh size={16} />}
            showInlineError={false}
          />
          {updatable.length > 0 && (
            <ManageForm
              action={updateAll}
              label={`Update all (${updatable.length})`}
              pendingLabel="Updating…"
              success={`${updatable.length} plugin(s) updated`}
              variant="primary"
              confirm={{
                title: `Update ${updatable.length} plugin(s)?`,
                description: `Every plugin with an available update on ${site.name} will be updated in one pass. Plugin updates can change how the site behaves — take a backup if you are unsure.`,
                confirmLabel: "Update all",
              }}
              showInlineError={false}
            />
          )}
        </div>
      </div>

      <Card className="overflow-hidden">
        {plugins.length === 0 ? (
          <EmptyState
            icon={<IconPlugins size={28} />}
            title={snapshot ? "No plugins installed" : "No inventory yet"}
          >
            {snapshot
              ? "Install one from the Marketplace to get started."
              : "Refresh the inventory to pull the current plugin list from the site."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-body">
              <thead>
                <tr className={tableHeadClass}>
                  <th className="px-5 py-3 font-medium">Plugin</th>
                  <th className="px-5 py-3 font-medium">Version</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Update</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {plugins.map((p) => {
                  const activate = manageAction.bind(null, id, {
                    kind: "activate_plugin" as const, file: p.file,
                  });
                  const deactivate = manageAction.bind(null, id, {
                    kind: "deactivate_plugin" as const, file: p.file,
                  });
                  const update = manageAction.bind(null, id, {
                    kind: "update_plugin" as const, file: p.file,
                  });
                  const name = p.title || p.name;
                  return (
                    <tr key={p.file} className={tableRowClass}>
                      <td className={`${tableCellClass} font-medium text-ink`}>{name}</td>
                      <td className={`${tableCellClass} text-mid-gray`}>{p.version}</td>
                      <td className={tableCellClass}>
                        <StatusBadge tone={p.status === "active" ? "good" : "idle"}>
                          {p.status}
                        </StatusBadge>
                      </td>
                      <td className={tableCellClass}>
                        {p.update === "available" ? (
                          <StatusBadge tone="warn">{p.update_version ?? "available"}</StatusBadge>
                        ) : (
                          <span className="text-caption tracking-normal text-mid-gray">current</span>
                        )}
                      </td>
                      <td className={tableCellClass}>
                        <div className="flex flex-wrap justify-end gap-2">
                          {p.update === "available" && (
                            <ManageForm
                              action={update}
                              label="Update"
                              pendingLabel="Updating…"
                              success={`${name} updated`}
                              size="sm"
                              confirm={{
                                title: `Update ${name}?`,
                                description: `Version ${p.version} will be replaced with ${p.update_version ?? "the latest release"} on ${site.name}.`,
                                confirmLabel: "Update",
                              }}
                              showInlineError={false}
                            />
                          )}
                          {p.status === "active" ? (
                            <ManageForm
                              action={deactivate}
                              label="Deactivate"
                              pendingLabel="Deactivating…"
                              success={`${name} deactivated`}
                              size="sm"
                              variant="danger"
                              confirm={{
                                title: `Deactivate ${name}?`,
                                description: `Any functionality this plugin provides will stop working on ${site.name} immediately. You can reactivate it from this page.`,
                                confirmLabel: "Deactivate",
                                tone: "danger",
                              }}
                              showInlineError={false}
                            />
                          ) : (
                            <ManageForm
                              action={activate}
                              label="Activate"
                              pendingLabel="Activating…"
                              success={`${name} activated`}
                              size="sm"
                              confirm={{
                                title: `Activate ${name}?`,
                                description: `The plugin will start running on ${site.name} straight away.`,
                                confirmLabel: "Activate",
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
    </main>
  );
}
