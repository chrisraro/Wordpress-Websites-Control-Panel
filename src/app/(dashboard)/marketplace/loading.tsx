import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

export default function MarketplaceLoading() {
  return (
    <main aria-busy="true" aria-label="Loading marketplace">
      <Skeleton className="mb-6 h-8 w-48" />
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-32 rounded-3xl lg:col-span-2" />
        <Skeleton className="h-32 rounded-3xl" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={`${cardClass} p-5`}>
            <div className="flex gap-3">
              <Skeleton className="size-12 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <Skeleton className="mt-3 h-10 w-full" />
            <Skeleton className="mt-3 h-10 w-full rounded-2xl" />
          </div>
        ))}
      </div>
      <Skeleton className="mx-auto mt-6 h-9 w-48 rounded-2xl" />
    </main>
  );
}
