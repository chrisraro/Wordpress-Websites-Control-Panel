import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the connect-a-site form — breadcrumb, heading, subtitle, then a
 *  centered card with five label+field pairs and a full-width submit. */
export default function NewSiteLoading() {
  return (
    <main aria-busy="true" aria-label="Loading connect a site" className="mx-auto max-w-xl">
      <Skeleton className="mb-4 h-4 w-40" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="mt-2 h-4 w-full max-w-md" />
      <div className={`${cardClass} mt-6 space-y-5 p-5`}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-10 w-full rounded-2xl" />
          </div>
        ))}
        <Skeleton className="h-10 w-full rounded-2xl" />
      </div>
    </main>
  );
}
