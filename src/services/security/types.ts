export type CheckResult = "pass" | "fail" | "warn";
export interface SecurityCheck {
  check_id: string;
  result: CheckResult;
  details?: Record<string, unknown>;
}
export interface UptimeRow {
  site_id: string;
  http_status: number | null;
  response_ms: number | null;
  ssl_days_remaining: number | null;
  ok: boolean;
}
export type Severity = "critical" | "high" | "medium" | "low";
export type CoverageGap = "vuln_feed" | "core_checksums" | "http_probes";
export const COVERAGE_GAPS: readonly CoverageGap[] = ["vuln_feed", "core_checksums", "http_probes"];

/**
 * What a scan was actually able to check. Each false is a part of the site
 * the grade says nothing about -- see computeGrade for why that caps it.
 */
export type ScanCoverage = Record<CoverageGap, boolean>;

/** Client-safe wording: shown in the security tab, the dashboard and the PDF. */
export const COVERAGE_GAP_LABEL: Record<CoverageGap, string> = {
  vuln_feed: "Known vulnerabilities (the vulnerability list was missing or out of date)",
  core_checksums: "WordPress core files (checksums could not be verified)",
  http_probes: "Public web checks (the site could not be reached from outside)",
};

export interface Grade {
  grade: "A" | "B" | "C" | "D" | "F";
  score: number;
  /**
   * What the scan could not check. Empty = complete. Absent = a grade stored
   * before coverage was tracked, which says nothing either way.
   */
  incomplete?: CoverageGap[];
}

const HTTP_PROBE_IDS = ["xmlrpc_enabled", "uploads_listing", "security_headers"];

/**
 * Derived from the checks themselves, so the grade row and the checklist can
 * never disagree about what ran.
 *
 * - vuln_feed: no "feed absent" / "feed stale" warn was recorded.
 * - core_checksums: the check exists and did not error. runChecksums reports
 *   both a failed PHP call and "no checksums published" as a warn carrying
 *   `details.error`; a warn for genuinely missing files is a real result.
 * - http_probes: every outside probe got an HTTP answer.
 */
export function scanCoverage(checks: SecurityCheck[]): ScanCoverage {
  const byId = new Map(checks.map((c) => [c.check_id, c]));
  const checksums = byId.get("core_checksums");
  return {
    vuln_feed: !byId.has("wordfence_feed") && !byId.has("wordfence_feed_stale"),
    core_checksums: checksums !== undefined && !(checksums.details && "error" in checksums.details),
    http_probes: HTTP_PROBE_IDS.every((id) => {
      const c = byId.get(id);
      return c !== undefined && c.details?.status !== "unreachable";
    }),
  };
}

export function coverageGaps(coverage: ScanCoverage): CoverageGap[] {
  return COVERAGE_GAPS.filter((g) => !coverage[g]);
}

/** Highest score an incomplete scan may report: the top of the C band. */
export const INCOMPLETE_SCORE_CAP = 79;

/**
 * The one sentence every surface shows for a partial grade (security tab,
 * PDF, share page), so they cannot drift apart. Null when there is nothing to
 * say: a complete grade, or one stored before coverage was tracked.
 */
export function incompleteGradeNotice(incomplete: readonly string[] | null | undefined): string | null {
  const gaps = (incomplete ?? []).filter((g): g is CoverageGap => g in COVERAGE_GAP_LABEL);
  if (gaps.length === 0) return null;
  return `Incomplete scan — could not check: ${gaps.map((g) => COVERAGE_GAP_LABEL[g]).join("; ")}. ` +
    "The grade is at most C until a scan can check everything.";
}

export function severityFromCvss(cvss: number | null): Severity | null {
  if (cvss === null || cvss <= 0) return null;
  if (cvss >= 9) return "critical";
  if (cvss >= 7) return "high";
  if (cvss >= 4) return "medium";
  return "low";
}

/**
 * An advisory that applies to every version that has ever existed and has no
 * fix. Two of these -- CVE-2022-3590 (blind SSRF) and CVE-2017-14990
 * (cleartext activation key) -- are "WordPress Core, all known versions", and
 * they match every install on earth.
 *
 * They are real, and they stay listed. But they cannot move a grade, because
 * a penalty every site pays identically carries no information: it cannot
 * distinguish any site from any other, and it costs a fifth of the scale
 * doing so. With them counted, no site could ever score above 80, "needs
 * attention" could never clear, and the number would quietly mean nothing.
 *
 * Deliberately narrow. A vulnerability with no fix YET, on a bounded version
 * range, is a genuine risk with a genuine action (deactivate, replace) and is
 * still scored. Only the unbounded-and-unfixable case is informational.
 */
export function isInformationalAdvisory(a: {
  fixed_in: string | null;
  affected_versions: Array<{ from_version: string; to_version: string }>;
}): boolean {
  if (a.fixed_in) return false;
  if (a.affected_versions.length === 0) return false;
  return a.affected_versions.every((r) => r.from_version === "*" && r.to_version === "*");
}

const VULN_WEIGHT: Record<string, number> = { critical: 30, high: 20, medium: 10, low: 5 };

export function computeGrade(input: {
  vulnSeverities: (Severity | null)[];
  checks: SecurityCheck[];
  uptime24h: number | null;
  /**
   * When given, an incomplete scan is capped at C. Each "could not check" is
   * only a 2-point warn, so without the cap a scan that verified almost
   * nothing could still read A -- a confident grade about things nobody
   * looked at.
   */
  coverage?: ScanCoverage;
}): Grade {
  let score = 100;
  for (const s of input.vulnSeverities) score -= VULN_WEIGHT[s ?? "low"] ?? 5;
  for (const c of input.checks) {
    if (c.result === "fail") score -= c.check_id === "core_checksums" ? 15 : 5;
    else if (c.result === "warn") score -= 2;
  }
  if (input.uptime24h !== null && input.uptime24h < 99) score -= 5;
  score = Math.max(0, score);
  const incomplete = input.coverage ? coverageGaps(input.coverage) : undefined;
  if (incomplete && incomplete.length > 0) score = Math.min(score, INCOMPLETE_SCORE_CAP);
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
  return incomplete ? { grade, score, incomplete } : { grade, score };
}
