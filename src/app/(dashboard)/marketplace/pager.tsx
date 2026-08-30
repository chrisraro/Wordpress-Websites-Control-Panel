import Link from "next/link";
import { buttonClass } from "@/components/ui/styles";

/** Builds `?q=...&page=...`, omitting `page` entirely for page 1 so the
 *  first page's URL stays the plain, shareable `basePath?q=...` it always
 *  was. */
function hrefFor(basePath: string, q: string | undefined, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * Plain `<Link>`s, not buttons: they work with middle-click and open-in-new-
 * tab, are crawlable in the ordinary way, and need no client JS — this stays
 * a Server Component so the marketplace pages it's used from can too.
 *
 * Prev/next are omitted (not merely disabled) at either end, per DESIGN.md's
 * preference for removing a dead control over rendering one that does
 * nothing. `flex-wrap` keeps this from overflowing at the 375px floor.
 */
export function Pager({
  basePath, q, page, totalPages,
}: {
  basePath: string;
  q?: string;
  page: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;

  return (
    <nav
      aria-label="Pagination"
      className="mt-6 flex flex-wrap items-center justify-center gap-3"
    >
      {page > 1 ? (
        <Link href={hrefFor(basePath, q, page - 1)} className={buttonClass("outline", "sm")}>
          Previous
        </Link>
      ) : null}
      <p className="text-caption tracking-normal text-mid-gray">
        Page {page} of {totalPages}
      </p>
      {page < totalPages ? (
        <Link href={hrefFor(basePath, q, page + 1)} className={buttonClass("outline", "sm")}>
          Next
        </Link>
      ) : null}
    </nav>
  );
}
