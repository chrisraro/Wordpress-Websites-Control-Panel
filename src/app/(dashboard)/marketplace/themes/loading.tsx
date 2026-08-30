import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the marketplace theme search — header, tab strip, search field,
 *  then a grid of theme cards with a screenshot, text and an install row. */
export default function MarketplaceThemesLoading() {
  return (
    <main aria-busy="true" aria-label="Loading themes">
      <Skeleton className="mb-6 h-8 w-48" />
      <Skeleton className="mb-6 h-11 w-64 rounded-3xl" />
      <Skeleton className="mb-6 h-24 rounded-3xl" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={`${cardClass} overflow-hidden`}>
            <Skeleton className="aspect-video w-full" />
            <div className="space-y-2 p-5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="mt-2 h-3 w-3/4" />
              <Skeleton className="mt-3 h-10 w-full rounded-2xl" />
            </div>
          </div>
        ))}
      </div>
      <Skeleton className="mx-auto mt-6 h-9 w-48 rounded-2xl" />
    </main>
  );
}
