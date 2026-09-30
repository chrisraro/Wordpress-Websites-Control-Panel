import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Same shape as the page: the overview band, then the directory's cards. */
export default function DashboardLoading() {
  return (
    <main aria-busy="true" aria-label="Loading overview">
      <Skeleton className="mb-6 h-8 w-40" />
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-6">
        {["col-span-2", "col-span-2", "col-span-2", "col-span-1 lg:col-span-2", "col-span-1 lg:col-span-2", "col-span-2"].map(
          (span, i) => (
            <div key={i} className={`${cardClass} ${span} space-y-3 p-5`}>
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-2 w-full" />
            </div>
          ),
        )}
      </div>
      <Skeleton className="mb-4 h-10 w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <div key={i} className={`${cardClass} overflow-hidden`}>
            <Skeleton className="aspect-[16/10] w-full rounded-none" />
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
              <div className="flex gap-1.5 pt-2">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-16" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
