import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the SEO tab — breadcrumb, heading, site tab strip, the audit
 *  score card, a four-stat row, findings, then two rows of paired cards. */
export default function SeoLoading() {
  return (
    <main aria-busy="true" aria-label="Loading SEO">
      <Skeleton className="mb-4 h-4 w-56" />
      <Skeleton className="mb-6 h-8 w-64" />
      <Skeleton className="mb-6 h-11 w-full max-w-2xl rounded-3xl" />

      <div className={`${cardClass} mb-4 flex flex-wrap items-center justify-between gap-6 p-5`}>
        <div className="flex flex-wrap items-center gap-6">
          <div className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-12 w-40" />
        </div>
        <Skeleton className="h-10 w-36 rounded-2xl" />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${cardClass} p-5`}>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-5 w-12" />
          </div>
        ))}
      </div>

      <div className={`${cardClass} mb-4 overflow-hidden`}>
        <div className="border-b border-hairline px-5 py-4">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="space-y-4 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className={`${cardClass} overflow-hidden`}>
            <div className="border-b border-hairline px-5 py-4">
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="space-y-4 p-5">
              {[0, 1, 2].map((r) => (
                <Skeleton key={r} className="h-4 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className={`${cardClass} overflow-hidden`}>
            <div className="border-b border-hairline px-5 py-4">
              <Skeleton className="h-4 w-28" />
            </div>
            <div className="space-y-4 p-5">
              {[0, 1, 2].map((r) => (
                <Skeleton key={r} className="h-4 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
