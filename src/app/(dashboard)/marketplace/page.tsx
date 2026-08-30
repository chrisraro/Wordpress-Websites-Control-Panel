import { searchPlugins, popularPlugins, type WpOrgSearchResult } from "@/lib/adapters/wporg";
import { listSites } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { requirePermission } from "@/lib/authz/server";
import { readDbFor } from "@/lib/authz/db";
import { InstallPanel } from "./install-panel";
import { UploadCard } from "./upload-card";
import { MarketplaceTabs } from "./marketplace-tabs";
import { Pager } from "./pager";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { SearchSubmit } from "@/components/ui/search-submit";
import { cardClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSearch, IconStar } from "@/components/ui/icons";
import { parsePage, clampToLastPage } from "@/lib/pagination";

export const dynamic = "force-dynamic";

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M+`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K+`;
  return String(n);
}

export default async function MarketplacePage({
  searchParams,
}: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const { q, page: pageParam } = await searchParams;
  const requestedPage = parsePage(pageParam);
  const viewer = await requirePermission("wp_toolkit.manage");
  const db = await readDbFor(viewer);
  const sites = (await listSites({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs: supabaseJobsRepo(db) }))
    .filter((s) => s.status !== "disabled")
    .map((s) => ({ id: s.id, name: s.name }));

  let results: WpOrgSearchResult | null = null;
  let searchError: string | null = null;
  try {
    results = q ? await searchPlugins(q, requestedPage) : await popularPlugins(requestedPage);
  } catch (e) {
    searchError = e instanceof Error ? e.message : "wordpress.org search failed";
  }
  // wordpress.org reinterprets an out-of-range page rather than rejecting it
  // (probed live), so the page shown is clamped to what this response
  // actually reports having, keeping the pager's "Page X of Y" internally
  // consistent even for a bookmarked or hand-edited ?page=.
  const page = results ? clampToLastPage(requestedPage, results.pages) : requestedPage;

  return (
    <main>
      <PageHeader
        title="Marketplace"
        subtitle="Search wordpress.org, or upload your own plugin, and install across sites in one pass."
      />

      <MarketplaceTabs active="plugins" />

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <form action="/marketplace" method="get" className={`${cardClass} p-5 lg:col-span-2`}>
          <label htmlFor="q" className={labelClass}>
            Search plugins
          </label>
          <div className="mt-1.5 flex gap-2">
            <div className="relative flex-1">
              <IconSearch
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mid-gray"
              />
              <input
                id="q"
                name="q"
                defaultValue={q ?? ""}
                placeholder="caching, seo, forms…"
                className={`${inputClass} pl-9`}
              />
            </div>
            <SearchSubmit label="Search" pendingLabel="Searching…" />
          </div>
          <p className="mt-2 text-caption tracking-normal text-mid-gray">
            {q ? `Results for “${q}”` : "Most popular right now"}
            {results ? ` · ${results.total.toLocaleString()} found` : ""}
          </p>
        </form>

        <UploadCard sites={sites} />
      </div>

      {searchError ? (
        <Card>
          <EmptyState icon={<IconAlert size={28} />} title="wordpress.org is not responding">
            {searchError}. Uploading a plugin still works — that path does not depend on
            wordpress.org.
          </EmptyState>
        </Card>
      ) : results!.plugins.length === 0 ? (
        <Card>
          <EmptyState icon={<IconSearch size={28} />} title={`Nothing matched “${q}”`}>
            Try a broader term, or upload the plugin directly if it is not on wordpress.org.
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {results!.plugins.map((p) => (
            <li key={p.slug} className={`${cardClass} flex flex-col p-5`}>
              <div className="flex items-start gap-3">
                {p.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.icon}
                    alt=""
                    width={48}
                    height={48}
                    className="size-12 shrink-0 rounded-2xl border border-hairline object-cover"
                  />
                ) : (
                  <div
                    aria-hidden
                    className="flex size-12 shrink-0 items-center justify-center rounded-2xl
                      border border-hairline bg-canvas text-body-lg font-semibold text-mid-gray"
                  >
                    {p.name.charAt(0)}
                  </div>
                )}
                <div className="min-w-0">
                  <h2 className="truncate text-body font-medium text-ink" title={p.name}>
                    {p.name}
                  </h2>
                  <p className="truncate text-caption tracking-normal text-mid-gray">
                    {p.author} · v{p.version}
                  </p>
                </div>
              </div>

              <p className="mt-3 line-clamp-2 flex-1 text-body text-mid-gray">
                {p.short_description}
              </p>

              <p className="mt-3 flex flex-wrap items-center gap-x-2 text-caption tracking-normal text-mid-gray">
                <span className="inline-flex items-center gap-1">
                  <IconStar size={12} />
                  {p.rating > 0 ? `${Math.round(p.rating)}%` : "unrated"}
                  {p.num_ratings > 0 && ` (${p.num_ratings.toLocaleString()})`}
                </span>
                <span>· {formatInstalls(p.active_installs)} installs</span>
              </p>

              <InstallPanel slug={p.slug} name={p.name} sites={sites} />
            </li>
          ))}
        </ul>
      )}

      {results && results.plugins.length > 0 && (
        <Pager basePath="/marketplace" q={q} page={page} totalPages={results.pages} />
      )}
    </main>
  );
}
