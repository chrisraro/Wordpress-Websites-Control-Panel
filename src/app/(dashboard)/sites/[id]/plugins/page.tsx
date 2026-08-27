import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { SiteTabs } from "../tabs";
import { ManageForm, type ManageFormAction } from "../action-form";
import { manageAction, refreshInventoryAction } from "../manage-actions";

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

  const refresh = refreshInventoryAction.bind(null, id) as unknown as ManageFormAction;
  const updateAll = manageAction.bind(null, id, { kind: "update_all_plugins" as const }) as unknown as ManageFormAction;

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">Plugins</p>
      <SiteTabs siteId={id} active="plugins" />

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-slate-500">
          {snapshot
            ? `${plugins.length} plugins · ${updatable.length} updates · inventory from ${new Date(snapshot.taken_at).toLocaleString()}`
            : "No inventory yet — refresh to load plugins."}
        </p>
        <div className="flex flex-wrap gap-2">
          <a href="/marketplace" className="min-h-10 rounded border px-3 py-2 text-sm hover:bg-slate-100">
            Install new plugin
          </a>
          <ManageForm action={refresh} label="Refresh inventory" pendingLabel="Refreshing…"
            confirmMessage="Fetch fresh inventory from the site now?" />
          {updatable.length > 0 && (
            <ManageForm action={updateAll} label={`Update all (${updatable.length})`} pendingLabel="Updating…"
              confirmMessage={`Update ${updatable.length} plugin(s) on ${site.name}?`}
              buttonClassName="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50" />
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Plugin</th>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Update</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {plugins.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                {snapshot ? "No plugins found." : "Refresh inventory to see plugins."}
              </td></tr>
            ) : plugins.map((p) => {
              const activate = manageAction.bind(null, id, { kind: "activate_plugin" as const, file: p.file }) as unknown as ManageFormAction;
              const deactivate = manageAction.bind(null, id, { kind: "deactivate_plugin" as const, file: p.file }) as unknown as ManageFormAction;
              const update = manageAction.bind(null, id, { kind: "update_plugin" as const, file: p.file }) as unknown as ManageFormAction;
              return (
                <tr key={p.file} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{p.title || p.name}</td>
                  <td className="px-4 py-2">{p.version}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${p.status === "active"
                      ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-600"}`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {p.update === "available"
                      ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                          {p.update_version ?? "available"}
                        </span>
                      : <span className="text-xs text-slate-400">current</span>}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap justify-end gap-2">
                      {p.update === "available" && (
                        <ManageForm action={update} label="Update" pendingLabel="…"
                          confirmMessage={`Update ${p.name} to ${p.update_version ?? "latest"}?`} />
                      )}
                      {p.status === "active" ? (
                        <ManageForm action={deactivate} label="Deactivate" pendingLabel="…"
                          confirmMessage={`Deactivate ${p.name}? The site may lose functionality.`} />
                      ) : (
                        <ManageForm action={activate} label="Activate" pendingLabel="…"
                          confirmMessage={`Activate ${p.name}?`} />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
