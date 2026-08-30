/**
 * Pure pagination helpers shared by the plugin and theme marketplace pages.
 *
 * Both pages read `?page=` straight off the URL, and wordpress.org's own
 * query APIs do not validate that value for us: probed live, `request[page]`
 * silently reinterprets a negative number (`-4` came back as page 4 — an
 * `abs()`, not a rejection) and a non-numeric value quietly becomes page 1.
 * Trusting the API to do this sanitisation would put a wrong-but-plausible
 * page number in front of the user, so every page number is parsed and
 * clamped here — before it ever reaches an adapter call — rather than left
 * to whatever the upstream API happens to do with it today.
 */

/** Comfortably above any result set worth paging through by hand; exists
 *  only so a page number typed into the URL bar can't grow without bound. */
export const MAX_PAGE = 500;

/**
 * Turns whatever arrived in a `?page=` search param into a safe, positive
 * page number. Non-numeric (`"abc"`), fractional (`"2.7"`), zero and
 * negative input all fall back to page 1; anything absurdly large is capped
 * at `MAX_PAGE` rather than forwarded verbatim.
 */
export function parsePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  const page = Math.trunc(n);
  if (page < 1) return 1;
  return Math.min(page, MAX_PAGE);
}

/**
 * Clamps a page number to the last real page once the total is known — used
 * after a fetch for a `parsePage`-sanitised-but-still-out-of-range page (a
 * bookmarked `?page=40` for a query that now only has 12 pages) lands past
 * the end of the result set, so the page shown and the pager text agree.
 */
export function clampToLastPage(page: number, totalPages: number): number {
  return Math.min(page, Math.max(1, totalPages));
}
