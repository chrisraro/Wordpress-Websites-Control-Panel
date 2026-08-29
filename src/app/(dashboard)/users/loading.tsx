import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the users page frame — header with two actions, then a table of
 *  accounts — so the layout does not jump when the real data lands. */
export default function UsersLoading() {
  return (
    <main aria-busy="true" aria-label="Loading users">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-10 w-44 rounded-2xl" />
          <Skeleton className="h-10 w-36 rounded-2xl" />
        </div>
      </div>
      <div className={`${cardClass} overflow-hidden`}>
        <div className="space-y-4 p-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-4 w-40 flex-1" />
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-4 w-8" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
