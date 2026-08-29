import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the permission matrix — breadcrumb, header, then a fixed ten
 *  permissions by four roles grid (the row/column count never varies). */
export default function RolesLoading() {
  return (
    <main aria-busy="true" aria-label="Loading permission matrix">
      <Skeleton className="mb-4 h-4 w-48" />
      <div className="mb-6 space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className={`${cardClass} overflow-hidden`}>
        <div className="flex items-center gap-4 border-b border-hairline px-5 py-3">
          <Skeleton className="h-3 w-32" />
          <div className="ml-auto flex gap-8">
            {[0, 1, 2, 3].map((c) => (
              <Skeleton key={c} className="h-3 w-14" />
            ))}
          </div>
        </div>
        <div className="divide-y divide-hairline">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-3.5">
              <Skeleton className="h-4 w-48" />
              <div className="ml-auto flex gap-8">
                {[0, 1, 2, 3].map((c) => (
                  <Skeleton key={c} className="size-4" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
