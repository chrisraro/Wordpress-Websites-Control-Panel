import { searchThemes, popularThemes, type WpOrgThemeResult } from "@/lib/adapters/wporg";
import { listSites } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { requirePermission } from "@/lib/authz/server";
import { readDbFor } from "@/lib/authz/db";
import { InstallPanel } from "../install-panel";
import { MarketplaceTabs } from "../marketplace-tabs";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { SearchSubmit } from "@/components/ui/search-submit";
import { cardClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSearch, IconStar } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M+`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K+`;
  return String(n);
}

export default async function MarketplaceThemesPage({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const viewer = await requirePermission("wp_toolkit.manage");
  const db = await readDbFor(viewer);
  const sites = (await listSites({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs: supabaseJobsRepo(db) }))
    .filter((s) => s.status !== "disabled")
    .map((s) => ({ id: s.id, name: s.name }));

  let results: WpOrgThemeResult | null = null;
  let searchError: string | null = null;
  try {
    results = q ? await searchThemes(q) : await popularThemes();
  } catch (e) {
    searchError = e instanceof Error ? e.message : "wordpress.org search failed";
  }

  return (
    <main>
      <PageHeader
        title="Marketplace"
        subtitle="Search wordpress.org for a theme and install it across sites in one pass."
      />

      <MarketplaceTabs active="themes" />

      <form action="/marketplace/themes" method="get" className={`${cardClass} mb-6 p-5`}>
        <label htmlFor="q" className={labelClass}>
          Search themes
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
              placeholder="astra, storefront, blocksy…"
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

      {searchError ? (
        <Card>
          <EmptyState icon={<IconAlert size={28} />} title="wordpress.org is not responding">
            {searchError}. Installing a theme from a site's own Themes tab still works, since that
            path can also accept an uploaded .zip.
          </EmptyState>
        </Card>
      ) : results!.themes.length === 0 ? (
        <Card>
          <EmptyState icon={<IconSearch size={28} />} title={`Nothing matched “${q}”`}>
            Try a broader term, or upload the theme directly from a site's Themes tab if it is not
            on wordpress.org.
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {results!.themes.map((t) => (
            <li key={t.slug} className={`${cardClass} flex flex-col overflow-hidden`}>
              <div className="aspect-video w-full shrink-0 bg-canvas">
                {t.screenshot_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={t.screenshot_url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div
                    aria-hidden
                    className="flex h-full w-full items-center justify-center text-heading-sm
                      font-semibold text-mid-gray"
                  >
                    {t.name.charAt(0)}
                  </div>
                )}
              </div>

              <div className="flex flex-1 flex-col p-5">
                <h2 className="truncate text-body font-medium text-ink" title={t.name}>
                  {t.name}
                </h2>
                <p className="truncate text-caption tracking-normal text-mid-gray">
                  {t.author} · v{t.version}
                </p>

                <p className="mt-3 flex flex-1 flex-wrap items-start gap-x-2 text-caption tracking-normal text-mid-gray">
                  <span className="inline-flex items-center gap-1">
                    <IconStar size={12} />
                    {t.rating > 0 ? `${Math.round(t.rating)}%` : "unrated"}
                    {t.num_ratings > 0 && ` (${t.num_ratings.toLocaleString()})`}
                  </span>
                  <span>· {formatInstalls(t.active_installs)} installs</span>
                </p>

                <InstallPanel slug={t.slug} name={t.name} sites={sites} target="theme" />
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
