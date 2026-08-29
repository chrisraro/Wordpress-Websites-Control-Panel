import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the security tab — breadcrumb, heading, site tab strip, a grade
 *  summary card, a four-stat row, then vulnerabilities and checklist cards. */
export default function SecurityLoading() {
  return (
    <main aria-busy="true" aria-label="Loading security">
      <Skeleton className="mb-4 h-4 w-56" />
      <Skeleton className="mb-6 h-8 w-64" />
      <Skeleton className="mb-6 h-11 w-full max-w-2xl rounded-3xl" />

      <div className={`${cardClass} mb-4 flex flex-wrap items-center justify-between gap-4 p-5`}>
        <div className="flex items-center gap-4">
          <Skeleton className="size-16 shrink-0 rounded-3xl" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
        <Skeleton className="h-10 w-40 rounded-2xl" />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${cardClass} p-5`}>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-5 w-12" />
          </div>
        ))}
      </div>

      <div className={`${cardClass} mb-4 overflow-hidden`}>
        <div className="border-b border-hairline px-5 py-4">
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-4 w-48 flex-1" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
      </div>

      <div className={`${cardClass} overflow-hidden`}>
        <div className="border-b border-hairline px-5 py-4">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="divide-y divide-hairline px-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between gap-2 py-2.5">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-5 w-14" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
