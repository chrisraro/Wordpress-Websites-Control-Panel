import type { SiteStatus } from "./types";

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
  /** Plain-language reasons, worst first. Empty when nothing is wrong. */
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

  if (input.updates !== undefined && input.updates > 0) {
    reasons.push(`${input.updates} update${input.updates === 1 ? "" : "s"} pending`);
    raise("warn");
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
export function isStaging(site: { url: string; client_label: string | null }): boolean {
  const url = site.url.toLowerCase();
  if (/(^|\/\/|\.)staging|\/staging|\bstage\d*\b|\.test\b|\.local\b/.test(url)) return true;
  return /staging|\bstage\b/i.test(site.client_label ?? "");
}
