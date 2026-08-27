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

export default async function ThemesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();
  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(id);
  const themes = snapshot?.payload.themes ?? [];

  const refresh = refreshInventoryAction.bind(null, id) as unknown as ManageFormAction;

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">Themes</p>
      <SiteTabs siteId={id} active="themes" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {snapshot
            ? `${themes.length} themes · inventory from ${new Date(snapshot.taken_at).toLocaleString()}`
            : "No inventory yet — refresh to load themes."}
        </p>
        <ManageForm action={refresh} label="Refresh inventory" pendingLabel="Refreshing…"
          confirmMessage="Fetch fresh inventory from the site now?" />
      </div>

      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Theme</th>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Update</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {themes.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                {snapshot ? "No themes found." : "Refresh inventory to see themes."}
              </td></tr>
            ) : themes.map((t) => {
              const update = manageAction.bind(null, id, { kind: "update_theme" as const, slug: t.name }) as unknown as ManageFormAction;
              return (
                <tr key={t.name} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{t.title || t.name}</td>
                  <td className="px-4 py-2">{t.version}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${t.status === "active"
                      ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-600"}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {t.update === "available"
                      ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                          {t.update_version ?? "available"}
                        </span>
                      : <span className="text-xs text-slate-400">current</span>}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end">
                      {t.update === "available" && (
                        <ManageForm action={update} label="Update" pendingLabel="…"
                          confirmMessage={`Update theme ${t.name} to ${t.update_version ?? "latest"}?`} />
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
