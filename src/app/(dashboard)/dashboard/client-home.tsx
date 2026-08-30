import Link from "next/link";
import { Card, EmptyState, StatusBadge } from "@/components/ui/primitives";
import { IconChevronRight, IconReport } from "@/components/ui/icons";
import type { Severity } from "@/services/sites/portfolio";
import type { SiteRow } from "@/services/sites/types";

/**
 * The landing screen for a client.
 *
 * PRODUCT.md is explicit that this is not the staff console with buttons
 * hidden: "A client is not a member of staff with buttons hidden -- they are
 * a customer checking on work they are paying for. What reassures them is
 * evidence the site is healthy and a report they can forward, not a denser
 * console." Principle 5 names the anti-pattern outright -- "here is the
 * console with most of it removed" -- and until now that was literally what a
 * client got: the staff dashboard with `can()` returning false.
 *
 * So this is a different screen, not a filtered one. Three deliberate
 * departures from the staff dashboard:
 *
 *   1. No triage. Staff want the exception list because they are working a
 *      queue of twelve sites; a client wants to know their own site is fine.
 *      Every site gets a plain sentence, in the order they were granted.
 *   2. No internal vocabulary. "degraded", "snapshot", "inventory",
 *      "abilities", "pending updates" and security letter grades are the
 *      agency's words for its own work. A customer reads "We're on it", not
 *      "Connection is failing intermittently".
 *   3. The report is the destination, not a tab. It is the artefact they can
 *      actually use and forward, so it is the only call to action here.
 *
 * What it deliberately does NOT do is reassure falsely. Principle 4 --
 * "empty, unmeasured, failed and stale are different states" -- binds here
 * more than anywhere, because this is the audience least able to tell the
 * difference. A site that has never been checked says so.
 */

export interface ClientSiteRow {
  site: SiteRow;
  severity: Severity;
  /** When the last successful check ran; null when there has never been one. */
  lastCheckedIso: string | null;
}

/**
 * Plain-language health, written for someone who does not work at OCS.
 *
 * Never names the mechanism. A client cannot act on "the MCP connection is
 * failing intermittently" and should not have to; what they need to know is
 * whether anyone is dealing with it. The reassurance is honest -- staff do
 * see these on their own dashboard as an exception -- without implying a
 * timeline nobody has promised.
 */
export function clientHealth(row: ClientSiteRow): { tone: "good" | "warn" | "idle"; line: string } {
  if (row.lastCheckedIso === null) {
    // Not "healthy". Nothing has ever been measured, and saying otherwise
    // would be the single most misleading sentence on this screen.
    return { tone: "idle", line: "We haven’t completed a check on this site yet." };
  }
  if (row.site.status === "disabled") {
    return { tone: "idle", line: "This site isn’t being monitored right now." };
  }
  if (row.severity === "critical") {
    return { tone: "warn", line: "We’ve found something that needs our attention, and we’re on it." };
  }
  if (row.severity === "warn") {
    return { tone: "warn", line: "We’re working on a couple of maintenance items." };
  }
  return { tone: "good", line: "Everything looks healthy." };
}

/** "2 days ago" beats a raw locale timestamp for a once-a-month visitor. */
function relativeDays(iso: string, now: number): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "last month" : `${months} months ago`;
}

export function ClientHome({
  rows,
  now,
}: {
  rows: ClientSiteRow[];
  /** Passed in so the server renders one timestamp for the whole page. */
  now: number;
}) {
  return (
    <main>
      <div className="mb-8">
        <h1 className="text-heading-sm font-semibold text-ink">Your sites</h1>
        <p className="mt-1 text-body text-mid-gray">
          Maintained by Online Creative Solutions. Checked automatically every day.
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No sites shared with you yet">
          Once your account is linked to a site, it will appear here with its latest report.
        </EmptyState>
      ) : (
        <ul className="space-y-4">
          {rows.map((row) => {
            const { tone, line } = clientHealth(row);
            return (
              <li key={row.site.id}>
                <Card className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h2 className="text-subheading font-semibold text-ink">{row.site.name}</h2>
                      <p className="mt-0.5 truncate text-caption tracking-normal text-mid-gray">
                        {row.site.url.replace(/^https?:\/\//, "")}
                      </p>
                    </div>
                    <StatusBadge tone={tone === "good" ? "good" : tone === "warn" ? "warn" : "idle"}>
                      {tone === "good" ? "Healthy" : tone === "warn" ? "In progress" : "Not checked"}
                    </StatusBadge>
                  </div>

                  <p className="mt-3 text-body text-ink">{line}</p>
                  {row.lastCheckedIso && (
                    <p className="mt-1 text-caption tracking-normal text-mid-gray">
                      Last checked {relativeDays(row.lastCheckedIso, now)}.
                    </p>
                  )}

                  {/* The only action, because it is the only one that is
                      theirs. Everything else this product does is work the
                      agency performs on their behalf. */}
                  <Link
                    href={`/sites/${row.site.id}/reports`}
                    className="group mt-4 inline-flex min-h-10 items-center gap-2 rounded-2xl
                      bg-canvas px-3 text-body font-medium text-ink transition-colors duration-150
                      hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-offset-2
                      focus-visible:outline-ink pointer-coarse:min-h-11"
                  >
                    <IconReport size={16} className="shrink-0" />
                    Reports for this site
                    <IconChevronRight
                      size={16}
                      className="shrink-0 text-mid-gray transition-transform duration-150
                        group-hover:translate-x-0.5"
                    />
                  </Link>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
