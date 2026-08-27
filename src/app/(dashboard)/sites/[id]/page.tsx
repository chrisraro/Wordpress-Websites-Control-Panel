import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { runConnectionTest } from "./actions";

export const dynamic = "force-dynamic";

const TABS = ["Overview", "Plugins", "Themes", "Security", "SEO", "GeoGrid", "Reports"] as const;

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repo = supabaseSitesRepo(createServiceSupabase());
  const site = await getSite({ repo, mcp: createSiteMcpClient }, id);
  if (!site) notFound();

  const db = createServiceSupabase();
  const { data: activity } = await db
    .from("activity_log")
    .select("action,detail,at")
    .eq("site_id", id)
    .order("at", { ascending: false })
    .limit(10);

  // runConnectionTest resolves to a result object (used by callers that want the
  // outcome); the <form action> contract only needs void | Promise<void>, and React
  // discards the resolved value for a plain (non-useActionState) form action.
  const testAction = runConnectionTest.bind(null, id) as unknown as (
    formData: FormData,
  ) => Promise<void>;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 break-words text-2xl font-semibold">{site.name}</h1>
        <form action={testAction}>
          <button className="rounded border px-3 py-2 text-sm hover:bg-slate-100">
            Test connection
          </button>
        </form>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        <a href={site.url} target="_blank" rel="noreferrer" className="break-all underline">{site.url}</a>
        {" · "}status: {site.status.replace("_", " ")}
      </p>

      <nav className="mb-6 flex gap-1 overflow-x-auto border-b">
        {TABS.map((t, i) => (
          <span key={t}
            className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm ${i === 0
              ? "border-b-2 border-slate-900 font-medium"
              : "cursor-not-allowed text-slate-400"}`}
            title={i === 0 ? undefined : "Coming in a later phase"}
            {...(i === 0 && { "aria-current": "page" })}
            {...(i !== 0 && { "aria-disabled": "true" })}>
            {t}
            {i !== 0 && <span className="sr-only"> (coming in a later phase)</span>}
          </span>
        ))}
      </nav>

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
                  <span>{a.action}</span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {new Date(a.at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
