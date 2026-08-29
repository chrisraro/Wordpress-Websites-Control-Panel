import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the reports tab — breadcrumb, heading, subtitle, site tab strip,
 *  the generate-report form, then the generated-reports table. */
export default function ReportsLoading() {
  return (
    <main aria-busy="true" aria-label="Loading reports">
      <Skeleton className="mb-4 h-4 w-56" />
      <Skeleton className="h-8 w-64" />
      <Skeleton className="mb-6 mt-1 h-4 w-72" />
      <Skeleton className="mb-6 h-11 w-full max-w-2xl rounded-3xl" />

      <div className="mb-4 space-y-3">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-3 w-full max-w-prose" />
        <div className={`${cardClass} space-y-4 p-5`}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
          <Skeleton className="h-10 w-40 rounded-2xl" />
        </div>
      </div>

      <div className={`${cardClass} overflow-hidden`}>
        <div className="border-b border-hairline px-5 py-4">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="space-y-4 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-40 flex-1" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-8 w-16" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
