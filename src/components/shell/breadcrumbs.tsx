import Link from "next/link";
import { LinkPending } from "./nav-progress";
import { IconChevronRight } from "@/components/ui/icons";

export interface Crumb {
  label: string;
  /** Omit on the final crumb — the current page is not a link to itself. */
  href?: string;
}

/** Purely typographic hierarchy: no background, no borders (DESIGN.md). */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4">
      <ol className="flex flex-wrap items-center gap-1 text-body">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex min-w-0 items-center gap-1">
              {i > 0 && (
                <IconChevronRight size={14} className="shrink-0 text-mid-gray" />
              )}
              {item.href && !last ? (
                <Link
                  href={item.href}
                  className="truncate text-mid-gray transition-colors duration-150 hover:text-ink"
                >
                  {item.label}
                  <LinkPending />
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={last ? "truncate font-medium text-ink" : "truncate text-mid-gray"}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
