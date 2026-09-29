import Link from "next/link";
import { Card, EmptyState } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { IconSearch, IconSites } from "@/components/ui/icons";
import { SearchSubmit } from "@/components/ui/search-submit";
import {
  DIRECTORY_ENV_LABEL, DIRECTORY_PAGE_SIZE, DIRECTORY_SORT_LABEL, directoryHref,
  type DirectoryEnv, type DirectoryPage, type DirectoryQuery, type DirectorySort,
} from "@/services/sites/directory";
import { AutoSubmitSelect } from "./auto-submit-select";
import { SiteCard, type CatalogSite } from "./site-card";

// inputClass is full-width for text fields; a select sizes to its longest option.
const selectClass = `${inputClass.replace("w-full ", "")} w-auto cursor-pointer pr-8`;

function Pager({ query, result }: { query: DirectoryQuery; result: DirectoryPage<CatalogSite> }) {
  if (result.totalPages <= 1) return null;
  const { page, totalPages } = result;
  return (
    <nav aria-label="Site directory pages" className="mt-6 flex flex-wrap items-center justify-center gap-2">
      {page > 1 && (
        <Link href={directoryHref(query, { page: page - 1 })} className={buttonClass("outline", "sm")}>
          Previous
        </Link>
      )}
      {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
        <Link
          key={n}
          href={directoryHref(query, { page: n })}
          aria-current={n === page ? "page" : undefined}
          aria-label={`Page ${n}`}
          className={buttonClass(n === page ? "primary" : "ghost", "sm", "min-w-9")}
        >
          {n}
        </Link>
      ))}
      {page < totalPages && (
        <Link href={directoryHref(query, { page: page + 1 })} className={buttonClass("outline", "sm")}>
          Next
        </Link>
      )}
    </nav>
  );
}

/**
 * The site directory: every connected site as a card, ten to a page.
 *
 * One list with an environment filter replaces the old Production/Staging
 * tabs; the environment is instead on every card, and the filter and sort
 * ("Live first" / "Staging first") put either group together on demand.
 * A plain GET form keeps the whole view in the URL.
 */
export function SiteCatalog({
  query, result, counts,
}: {
  query: DirectoryQuery;
  result: DirectoryPage<CatalogSite>;
  counts: Record<DirectoryEnv, number>;
}) {
  const filtered = query.q !== "" || query.env !== "all";
  const first = (result.page - 1) * DIRECTORY_PAGE_SIZE + 1;
  const last = first + result.items.length - 1;

  return (
    <section aria-labelledby="sites" className="scroll-mt-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="sites" className="text-subheading font-semibold text-ink">Site directory</h2>
        <p className="text-caption tracking-normal text-mid-gray" aria-live="polite">
          {result.total === 0
            ? "No matching sites"
            : `Showing ${first}–${last} of ${result.total}${filtered ? ` matching` : ""} site${result.total === 1 ? "" : "s"}`}
        </p>
      </div>

      <form
        action="/dashboard#sites"
        method="get"
        role="search"
        className="mb-4 flex flex-wrap items-center gap-2"
      >
        <div className="relative min-w-56 flex-1">
          <IconSearch
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mid-gray"
          />
          <input
            type="search"
            name="q"
            defaultValue={query.q}
            placeholder="Search by name, URL or client"
            aria-label="Search sites"
            maxLength={100}
            className={`${inputClass} pl-10`}
          />
        </div>
        <AutoSubmitSelect name="env" defaultValue={query.env} label="Environment" className={selectClass}>
          {(Object.keys(DIRECTORY_ENV_LABEL) as DirectoryEnv[]).map((e) => (
            <option key={e} value={e}>{DIRECTORY_ENV_LABEL[e]} ({counts[e]})</option>
          ))}
        </AutoSubmitSelect>
        <AutoSubmitSelect name="sort" defaultValue={query.sort} label="Sort by" className={selectClass}>
          {(Object.keys(DIRECTORY_SORT_LABEL) as DirectorySort[]).map((s) => (
            <option key={s} value={s}>{DIRECTORY_SORT_LABEL[s]}</option>
          ))}
        </AutoSubmitSelect>
        <SearchSubmit label="Search" pendingLabel="Searching…" />
        {(filtered || query.sort !== "attention") && (
          <Link href="/dashboard#sites" className={buttonClass("ghost")}>Clear</Link>
        )}
      </form>

      {result.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconSites size={28} />}
            title="No sites match"
            action={<Link href="/dashboard#sites" className={`${buttonClass("outline")} mt-1`}>Show all sites</Link>}
          >
            {query.q ? `Nothing matches “${query.q}”` : "Nothing matches this filter"}
            {query.env !== "all" && ` among ${DIRECTORY_ENV_LABEL[query.env].toLowerCase()} sites`}.
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {result.items.map((site) => <SiteCard key={site.id} site={site} />)}
        </ul>
      )}

      <Pager query={query} result={result} />
    </section>
  );
}
