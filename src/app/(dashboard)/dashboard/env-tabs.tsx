import Link from "next/link";
import { badgeClass } from "@/components/ui/styles";
import type { SiteEnvironment } from "@/services/sites/types";

export interface EnvTabCounts {
  total: number;
  needsAttention: number;
}

/**
 * Splits the portfolio into production and staging.
 *
 * The split is a real one for this team: four of twelve sites are staging
 * copies of client production sites, and PRODUCT.md names acting on the wrong
 * environment as the expensive mistake this product can cause. Reading a list
 * where the two are interleaved is where that mistake starts.
 *
 * The count of sites needing attention is shown on BOTH tabs, including the
 * one you are not looking at, and that is the whole reason this component
 * exists rather than a bare pair of links. The dashboard's job is a sweep for
 * exceptions across the portfolio; splitting it into two views would
 * otherwise mean a broken staging site is invisible while you are on
 * Production. The number on the inactive tab keeps the sweep whole -- you can
 * choose not to look, but you cannot fail to notice.
 *
 * Server-rendered links rather than client state: the choice belongs in the
 * URL so it survives a reload, can be linked to a colleague, and needs no
 * JavaScript to work.
 */
export function EnvTabs({
  active, production, staging,
}: {
  active: SiteEnvironment;
  production: EnvTabCounts;
  staging: EnvTabCounts;
}) {
  const tabs = [
    { key: "production" as const, label: "Production", counts: production },
    { key: "staging" as const, label: "Staging", counts: staging },
  ];

  return (
    <nav aria-label="Site environment" className="mb-6 -mx-1 overflow-x-auto px-1 pb-1">
      <ul className="flex w-max min-w-full gap-1 rounded-3xl bg-canvas p-1">
        {tabs.map(({ key, label, counts }) => {
          const isActive = active === key;
          return (
            <li key={key} className="flex-1">
              <Link
                href={key === "production" ? "/dashboard" : `/dashboard?env=${key}`}
                aria-current={isActive ? "page" : undefined}
                className={`flex min-h-9 items-center justify-center gap-2 whitespace-nowrap
                  rounded-2xl px-3 text-body transition-colors duration-150
                  pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2
                  focus-visible:outline-ink ${
                    isActive
                      ? "bg-paper font-medium text-ink shadow-subtle"
                      : "text-mid-gray hover:text-ink"
                  }`}
              >
                <span>{label}</span>
                <span className="text-caption tracking-normal text-mid-gray">
                  {counts.total}
                </span>
                {/* The signal that makes the split safe. Rendered on the
                    inactive tab too, so an exception on the other side of the
                    divide is never silent. */}
                {counts.needsAttention > 0 && (
                  <span
                    className={badgeClass("soft", "text-status-warn")}
                    aria-label={`${counts.needsAttention} need attention`}
                  >
                    {counts.needsAttention}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
