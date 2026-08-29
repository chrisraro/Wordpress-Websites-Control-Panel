import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

export default function DashboardLoading() {
  return (
    <main aria-busy="true" aria-label="Loading sites">
      <Skeleton className="mb-6 h-8 w-32" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={`${cardClass} p-5`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-5 w-20 shrink-0" />
            </div>
            <div className="mt-4 flex gap-1.5">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-20" />
            </div>
            <Skeleton className="mt-4 h-3 w-24" />
          </div>
        ))}
      </div>
    </main>
  );
}
