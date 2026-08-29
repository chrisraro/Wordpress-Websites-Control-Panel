import { Skeleton } from "@/components/ui/primitives";
import { cardClass } from "@/components/ui/styles";

/** Mirrors the user detail page frame — breadcrumb, header with a role
 *  badge, then three stacked cards (Role, Site access, Delete account). */
export default function UserDetailLoading() {
  return (
    <main aria-busy="true" aria-label="Loading user">
      <Skeleton className="mb-4 h-4 w-40" />
      <div className="mb-6 space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-5 w-24" />
      </div>
      <div className="space-y-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className={`${cardClass} overflow-hidden`}>
            <div className="border-b border-hairline px-5 py-4">
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="space-y-3 p-5">
              <Skeleton className="h-4 w-full max-w-md" />
              <Skeleton className="h-4 w-2/3 max-w-sm" />
              <Skeleton className="h-10 w-40 rounded-2xl" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
