import { StatusBadge, type StatusTone } from "@/components/ui/primitives";
import type { GscStatus } from "@/services/gsc/types";

/**
 * What the panel actually knows about a site's Search Console verification.
 *
 * The label never says "Verified", and that restraint is the point. This
 * panel can see whether a verification token is INSTALLED on the site; only
 * Google knows whether a property is VERIFIED, and the two come apart in both
 * directions — a token can sit on a site nobody ever added to Search Console,
 * and a property can be verified through DNS or a linked Analytics account
 * with nothing on the site at all. A badge reading "Verified" would be the
 * panel asserting something it cannot check, on a screen people use to decide
 * whether they still have work to do.
 */
export function GscBadge({ status }: { status: GscStatus | null }) {
  if (!status) return <StatusBadge tone="idle">Not checked</StatusBadge>;
  const tone: StatusTone =
    status.state === "installed" ? "good" : status.state === "malformed" ? "bad" : "warn";
  const label =
    status.state === "installed"
      ? "Verification installed"
      : status.state === "malformed"
        ? "Verification broken"
        : "No verification";
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}
