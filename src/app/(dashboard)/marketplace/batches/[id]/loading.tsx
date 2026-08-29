import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the batch page frame — breadcrumb, heading, id line — plus the
 *  same three-row card BatchPoller itself shows before its first poll. */
export default function BatchLoading() {
  return (
    <main aria-busy="true" aria-label="Loading batch">
      <Skeleton className="mb-4 h-4 w-40" />
      <Skeleton className="h-8 w-20" />
      <Skeleton className="mb-6 mt-1 h-3 w-72" />
      <div className={`${cardClass} overflow-hidden`}>
        <div className="space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-5 flex-1" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
