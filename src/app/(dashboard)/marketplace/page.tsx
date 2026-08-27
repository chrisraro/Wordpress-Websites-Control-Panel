import { searchPlugins, popularPlugins, type WpOrgSearchResult } from "@/lib/adapters/wporg";
import { listSites } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { InstallPanel } from "./install-panel";
import { UploadCard } from "./upload-card";

export const dynamic = "force-dynamic";

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M+`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K+`;
  return String(n);
}

export default async function MarketplacePage({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const db = createServiceSupabase();
  const sites = (await listSites({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }))
    .filter((s) => s.status !== "disabled")
    .map((s) => ({ id: s.id, name: s.name }));

  let results: WpOrgSearchResult | null = null;
  let searchError: string | null = null;
  try {
    results = q ? await searchPlugins(q) : await popularPlugins();
  } catch (e) {
    searchError = e instanceof Error ? e.message : "wordpress.org search failed";
  }

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <h1 className="mb-4 text-2xl font-semibold">Marketplace</h1>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <form action="/marketplace" method="get" className="lg:col-span-2">
          <label htmlFor="q" className="mb-1 block text-sm font-medium">
            Search wordpress.org plugins
          </label>
          <div className="flex gap-2">
            <input id="q" name="q" defaultValue={q ?? ""} placeholder="e.g. caching, seo, forms"
              className="min-h-10 w-full rounded border px-3 py-2" />
            <button className="min-h-10 shrink-0 rounded bg-slate-900 px-4 py-2 text-sm text-white">
              Search
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {q ? `Results for "${q}"` : "Popular plugins"}
            {results ? ` · ${results.total} found` : ""}
          </p>
        </form>
        <UploadCard sites={sites} />
      </div>

      {searchError ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          wordpress.org is unavailable right now: {searchError}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {results!.plugins.map((p) => (
            <div key={p.slug} className="flex flex-col rounded-lg border bg-white p-4 shadow-sm">
              <div className="flex items-start gap-3">
                {p.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.icon} alt="" width={48} height={48} className="h-12 w-12 shrink-0 rounded" />
                ) : (
                  <div aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-slate-200 text-lg font-semibold text-slate-500">
                    {p.name.charAt(0)}
                  </div>
                )}
                <div className="min-w-0">
                  <h2 className="truncate font-medium" title={p.name}>{p.name}</h2>
                  <p className="truncate text-xs text-slate-500">by {p.author} · v{p.version}</p>
                </div>
              </div>
              <p className="mt-2 line-clamp-2 flex-1 text-sm text-slate-600">{p.short_description}</p>
              <p className="mt-2 text-xs text-slate-500">
                ★ {p.rating > 0 ? `${Math.round(p.rating)}%` : "—"} ({p.num_ratings}) · {formatInstalls(p.active_installs)} installs
              </p>
              <InstallPanel slug={p.slug} sites={sites} />
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
