import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { runConnectionTest } from "./actions";
import { SiteTabs } from "./tabs";
import { ManageForm, type ManageFormAction } from "./action-form";
import { manageAction, refreshInventoryAction } from "./manage-actions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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

  const testAction = runConnectionTest.bind(null, id) as unknown as (formData: FormData) => Promise<void>;
  const refresh = refreshInventoryAction.bind(null, id) as unknown as ManageFormAction;
  const updateCore = manageAction.bind(null, id, { kind: "update_core" as const }) as unknown as ManageFormAction;
  const maintenanceOn = manageAction.bind(null, id, { kind: "maintenance" as const, enable: true }) as unknown as ManageFormAction;
  const maintenanceOff = manageAction.bind(null, id, { kind: "maintenance" as const, enable: false }) as unknown as ManageFormAction;
  const flushCache = manageAction.bind(null, id, { kind: "flush_cache" as const }) as unknown as ManageFormAction;
  const flushPermalinks = manageAction.bind(null, id, { kind: "flush_permalinks" as const }) as unknown as ManageFormAction;

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 break-words text-2xl font-semibold">{site.name}</h1>
        <div className="flex flex-wrap gap-2">
          <ManageForm action={refresh} label="Refresh inventory" pendingLabel="Refreshing…"
            confirmMessage="Fetch fresh inventory from the site now?" />
          <form action={testAction}>
            <button className="min-h-10 rounded border px-3 py-2 text-sm hover:bg-slate-100">
              Test connection
            </button>
          </form>
        </div>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        <a href={site.url} target="_blank" rel="noreferrer" className="break-all underline">{site.url}</a>
        {" · "}status: {site.status.replace("_", " ")}
        {inv ? ` · WP ${inv.wp_version} · PHP ${inv.php_version}` : ""}
      </p>

      <SiteTabs siteId={id} active="overview" />

      {inv?.core_update && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <span>WordPress {inv.core_update} is available (current: {inv.wp_version}).</span>
          <ManageForm action={updateCore} label="Update core" pendingLabel="Updating…"
            confirmMessage={`Update WordPress core on ${site.name} to ${inv.core_update}? Back up first if unsure.`}
            buttonClassName="rounded bg-amber-600 px-3 py-2 text-sm text-white disabled:opacity-50" />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">Connection</h2>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="shrink-0 text-slate-500">MCP endpoint</dt>
              <dd className="min-w-0 truncate pl-4" title={site.mcp_endpoint}>{site.mcp_endpoint}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">WP user</dt>
              <dd>{site.wp_username}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Abilities</dt>
              <dd>{site.capabilities?.abilities?.length ?? 0}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Connected</dt>
              <dd>{new Date(site.created_at).toLocaleDateString()}</dd></div>
            {snapshot && (
              <div className="flex justify-between"><dt className="text-slate-500">Inventory</dt>
                <dd>{new Date(snapshot.taken_at).toLocaleString()}</dd></div>
            )}
          </dl>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-slate-500">All abilities</summary>
            <ul className="mt-2 max-h-48 overflow-y-auto text-xs text-slate-600">
              {(site.capabilities?.abilities ?? []).map((a) => <li key={a}>{a}</li>)}
            </ul>
          </details>
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">Recent activity</h2>
          {!activity?.length ? (
            <p className="text-sm text-slate-500">No activity yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {activity.map((a, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{a.action}</span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {new Date(a.at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">Tools</h2>
          <div className="flex flex-wrap gap-2 text-sm">
            <ManageForm action={maintenanceOn} label="Maintenance on" pendingLabel="…"
              confirmMessage={`Put ${site.name} into maintenance mode? Visitors will see a maintenance page.`} />
            <ManageForm action={maintenanceOff} label="Maintenance off" pendingLabel="…"
              confirmMessage={`Take ${site.name} out of maintenance mode?`} />
            <ManageForm action={flushCache} label="Flush cache" pendingLabel="…"
              confirmMessage={`Flush the object cache on ${site.name}?`} />
            <ManageForm action={flushPermalinks} label="Flush permalinks" pendingLabel="…"
              confirmMessage={`Flush rewrite rules on ${site.name}?`} />
          </div>
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">Administrators</h2>
          {!inv?.admin_users?.length ? (
            <p className="text-sm text-slate-500">No inventory yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {inv.admin_users.map((u) => (
                <li key={u.ID} className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">{u.user_login}</span>
                  <span className="text-slate-500">{u.user_email}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
