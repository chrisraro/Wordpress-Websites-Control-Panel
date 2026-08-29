import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the GeoGrid tab — breadcrumb, heading, subtitle, site tab strip,
 *  a keyword row, a four-stat row, the map, then the config section below. */
export default function GeoGridLoading() {
  return (
    <main aria-busy="true" aria-label="Loading GeoGrid">
      <Skeleton className="mb-4 h-4 w-56" />
      <Skeleton className="h-8 w-64" />
      <Skeleton className="mb-6 mt-1 h-4 w-80" />
      <Skeleton className="mb-6 h-11 w-full max-w-2xl rounded-3xl" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-9 w-48 rounded-3xl" />
        <Skeleton className="h-10 w-44 rounded-2xl" />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${cardClass} p-5`}>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-5 w-12" />
          </div>
        ))}
      </div>

      <Skeleton className="mb-4 h-80 w-full rounded-3xl sm:h-96" />

      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-full max-w-prose" />
        <Skeleton className="h-3 w-2/3 max-w-prose" />
        <Skeleton className="h-40 w-full rounded-3xl" />
      </div>
    </main>
  );
}
