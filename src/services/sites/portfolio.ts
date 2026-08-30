import type { SiteEnvironment, SiteStatus } from "./types";

/**
 * Portfolio triage for the dashboard.
 *
 * PRODUCT.md records that the recurring job is a sweep for exceptions across
 * every site, not a tour of a site list — so the dashboard has to decide what
 * needs attention rather than presenting twelve equal rows and leaving the
 * scan to the reader. That decision lives here, as pure functions, because it
 * is a rule worth testing and not a detail of how a row is drawn.
 */

export type Severity = "critical" | "warn" | "ok";

/** Sort key: worst first. */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warn: 1, ok: 2 };

export interface AttentionInput {
  status: SiteStatus;
  /** Pending plugin/theme/core updates; undefined when never scanned. */
  updates?: number;
  /** Latest security grade A–F; undefined when never scanned. */
  grade?: string;
}

export interface Attention {
  severity: Severity;
  /**
   * Plain-language reasons, worst first.
   *
   * Can be non-empty while `severity` is "ok": pending updates are reported
   * as a reason but do not raise severity, so a site with nothing wrong
   * except a maintenance backlog stays out of "Needs attention" and still
   * has something to say on the surfaces that ask.
   */
  reasons: string[];
}

/**
 * What, if anything, is wrong with one site.
 *
 * Reasons are sentences rather than badge labels on purpose: "12 updates" is
 * a metric, "12 updates pending" is a thing to do. The dashboard's job is to
 * tell someone what needs doing.
 *
 * SEO score is deliberately not an input. A low score is a standing condition
 * to work on, not a fault that appeared — folding it in here would put every
 * site with mediocre SEO permanently in the same list as a site whose
 * connection just died, and the list stops meaning anything.
 */
export function siteAttention(input: AttentionInput): Attention {
  const reasons: string[] = [];
  let severity: Severity = "ok";
  const raise = (s: Severity) => {
    if (SEVERITY_RANK[s] < SEVERITY_RANK[severity]) severity = s;
  };

  // A disabled site is a deliberate state, not a fault. It must never appear
  // in a list of things demanding action, or the list trains people to ignore
  // it.
  if (input.status === "disabled") return { severity: "ok", reasons: [] };

  if (input.status === "reconnect_needed") {
    reasons.push("Connection lost — this site can't be managed until it is reconnected");
    raise("critical");
  } else if (input.status === "degraded") {
    reasons.push("Connection is failing intermittently");
    raise("warn");
  }

  if (input.grade === "F") {
    reasons.push("Security grade F");
    raise("critical");
  } else if (input.grade === "D") {
    reasons.push("Security grade D");
    raise("warn");
  }

  // Deliberately does NOT raise severity. Pending updates are work to do,
  // not a fault that appeared -- the same distinction already applied to SEO
  // score above, and it has to apply here for the same reason.
  //
  // Measured against the live portfolio before this changed: every one of
  // the twelve connected sites had at least one pending update, so every one
  // of them was `warn`, every severity dot rendered the same amber, and
  // "Needs attention" listed the entire portfolio in alphabetical order. A
  // list that contains everything ranks nothing: a site whose connection had
  // died sorted level with a staging copy that had one plugin update, and
  // the only genuine security finding (grade D) sat last on the page.
  //
  // Updates still surface -- as a metric badge on the row, and as a reason
  // line on sites that are in the list for some other cause -- so the
  // maintenance job keeps its entry point without drowning the fault list.
  if (input.updates !== undefined && input.updates > 0) {
    reasons.push(`${input.updates} update${input.updates === 1 ? "" : "s"} pending`);
  }

  return { severity, reasons };
}

/**
 * Whether a site is identifiably a staging copy.
 *
 * PRODUCT.md names running a bulk action against the wrong environment as the
 * expensive mistake this product can cause, and four of the connected sites
 * are staging copies of client production sites.
 *
 * Deliberately one-directional. `true` means "identified as staging"; `false`
 * means only "not identified", never "confirmed production". That asymmetry is
 * the whole point: a staging site mistaken for production gets treated with
 * unnecessary care, which costs nothing, while a production site mistaken for
 * staging is the catastrophe. So the UI marks staging and stays silent
 * otherwise, rather than labelling anything production on this evidence.
 *
 * Both the URL and the operator-set label are consulted: some staging installs
 * live in a subdirectory of another domain (`.../AralAbroad`) and are not
 * detectable from the URL at all.
 */
/**
 * The site's environment, preferring what the operator declared.
 *
 * `environment` (0017_site_environment.sql) is set at connect time and is
 * editable from the site's own page, so it is the answer whenever it exists.
 * `isStaging()` below is now only the rule that backfilled the column and a
 * fallback for a row that somehow predates it -- it is no longer the source
 * of truth for the constraint PRODUCT.md calls hardest.
 *
 * Falls back to "production" rather than "unknown" for the reason isStaging's
 * own docblock gives: a production site mistaken for staging is the
 * catastrophe, so an unresolved environment must read as the one that earns
 * more caution.
 */
export function siteEnvironment(site: {
  url: string;
  client_label: string | null;
  environment?: SiteEnvironment;
}): SiteEnvironment {
  if (site.environment) return site.environment;
  return isStaging(site) ? "staging" : "production";
}

/** Convenience for the many render sites that only ask "is this staging?". */
export function isStagingSite(site: {
  url: string;
  client_label: string | null;
  environment?: SiteEnvironment;
}): boolean {
  return siteEnvironment(site) === "staging";
}

export function isStaging(site: { url: string; client_label: string | null }): boolean {
  const url = site.url.toLowerCase();
  if (/(^|\/\/|\.)staging|\/staging|\bstage\d*\b|\.test\b|\.local\b/.test(url)) return true;
  return /staging|\bstage\b/i.test(site.client_label ?? "");
}
