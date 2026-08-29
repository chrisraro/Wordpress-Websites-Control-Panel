import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the site page frame — header, tab strip, two content columns — so
 *  the layout does not jump when the real data lands. */
export default function SiteLoading() {
  return (
    <main aria-busy="true" aria-label="Loading site">
      <Skeleton className="mb-4 h-4 w-56" />
      <Skeleton className="mb-6 h-8 w-64" />
      <Skeleton className="mb-6 h-11 w-full max-w-2xl rounded-3xl" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${cardClass} p-5`}>
            <Skeleton className="mb-4 h-4 w-32" />
            <div className="space-y-2.5">
              {[0, 1, 2, 3].map((r) => (
                <Skeleton key={r} className="h-4 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
