/**
 * A homepage screenshot for a site card: the fallback for sites that cannot
 * be shown live (see liveFrameUrl below and the card's SitePreview).
 *
 * Uses WordPress.com's public mShots service: it needs no key, is built for
 * exactly this (WordPress site thumbnails) and caches its captures, so the
 * dashboard never loads ten live client homepages into iframes. The trade-off
 * is that the site URL is sent to WordPress.com; every connected site is
 * already publicly reachable, and no credential or path beyond the homepage
 * URL is included.
 *
 * Staging copies get no screenshot: their URLs are often unlisted or
 * password-protected, and are not ours to hand to a third party.
 *
 * Returns null for anything that is not an http(s) URL, so a malformed
 * record can never become an image source.
 */
import type { SiteEnvironment } from "./types";

export const PREVIEW_WIDTH = 640;
export const PREVIEW_HEIGHT = 400;

export function sitePreviewUrl(siteUrl: string, environment: SiteEnvironment = "production"): string | null {
  if (environment === "staging") return null;
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(parsed.href)}`
    + `?w=${PREVIEW_WIDTH}&h=${PREVIEW_HEIGHT}`;
}

/**
 * The URL a card may load live in its sandboxed frame, or null to fall back
 * to the screenshot. https only (an http page inside the https panel is
 * blocked as mixed content), and only once an uptime check has seen the
 * homepage allow framing (uptime_checks.frameable, 0029); unknown is no.
 */
export function liveFrameUrl(siteUrl: string, frameable: boolean | null | undefined): string | null {
  if (frameable !== true) return null;
  try {
    const parsed = new URL(siteUrl);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
