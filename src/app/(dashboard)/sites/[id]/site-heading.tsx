import { badgeClass } from "@/components/ui/styles";
import { isStagingSite } from "@/services/sites/portfolio";

/**
 * The site's name and its environment, together, on every surface that can
 * act on the site.
 *
 * PRODUCT.md names running an action against the wrong environment as the
 * expensive mistake this product can cause, and four of the twelve connected
 * sites are staging copies of client production sites. Before this component
 * existed the STAGING chip was rendered in exactly one place — the dashboard
 * row — which is the one screen where no action is possible. Every surface
 * that *does* act (this site's detail page and all seven tabs, where "Update
 * all", "Update core" and "Maintenance on" live) rendered `{site.name}` bare.
 * Anyone arriving from a bookmark, a Slack link or a phone notification saw
 * no environment marker at all.
 *
 * The four staging sites happen to have "Staging" in their display name
 * today, which masked the gap. That is a naming coincidence, not a
 * safeguard — `isStagingSite()`'s own docblock notes that some staging installs
 * are subdirectory paths on another client's domain and are undetectable
 * from the URL.
 *
 * The chip matches the dashboard's exactly, including its solid tone: status
 * colour means health, and an environment is a category rather than a health
 * state, so this stays the one solid chip on the page and therefore the
 * loudest thing next to the name.
 */
export function SiteHeading({
  site,
  className = "mb-6",
}: {
  site: { name: string; url: string; client_label: string | null };
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${className}`}>
      <h1 className="break-words text-heading-sm font-semibold text-ink">{site.name}</h1>
      <StagingChip site={site} />
    </div>
  );
}

/** The chip on its own, for headers that compose their own heading block. */
export function StagingChip({
  site,
}: {
  site: { url: string; client_label: string | null };
}) {
  if (!isStagingSite(site)) return null;
  return (
    <span className={badgeClass("solid", "uppercase tracking-[0.08em]")}>Staging</span>
  );
}

/**
 * The environment as a suffix for confirmation-dialog titles.
 *
 * Returns "" for anything not identified as staging — `isStagingSite()` is
 * deliberately one-directional and `false` means "not identified", never
 * "confirmed production", so this must never render a PRODUCTION label it
 * cannot stand behind.
 *
 * This goes in the dialog *title* rather than the body: the body is a
 * paragraph people skim past on the way to the confirm button, and the point
 * is to be read before the click, not after.
 */
export function environmentSuffix(site: { url: string; client_label: string | null }): string {
  return isStagingSite(site) ? " (STAGING)" : "";
}
