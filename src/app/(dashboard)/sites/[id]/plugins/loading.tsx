import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the plugins tab — breadcrumb, heading, site tab strip, an
 *  inventory summary line with actions, then a table of plugin rows. */
export default function PluginsLoading() {
  return (
    <main aria-busy="true" aria-label="Loading plugins">
      <Skeleton className="mb-4 h-4 w-56" />
      <Skeleton className="mb-6 h-8 w-64" />
      <Skeleton className="mb-6 h-11 w-full max-w-2xl rounded-3xl" />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <Skeleton className="h-4 w-64" />
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-10 w-32 rounded-2xl" />
          <Skeleton className="h-10 w-40 rounded-2xl" />
        </div>
      </div>
      <div className={`${cardClass} overflow-hidden`}>
        <div className="space-y-4 p-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="size-4" />
              <Skeleton className="h-4 w-48 flex-1" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
