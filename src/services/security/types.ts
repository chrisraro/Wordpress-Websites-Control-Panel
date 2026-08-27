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
export interface Grade { grade: "A" | "B" | "C" | "D" | "F"; score: number }

export function severityFromCvss(cvss: number | null): Severity | null {
  if (cvss === null || cvss <= 0) return null;
  if (cvss >= 9) return "critical";
  if (cvss >= 7) return "high";
  if (cvss >= 4) return "medium";
  return "low";
}

const VULN_WEIGHT: Record<string, number> = { critical: 30, high: 20, medium: 10, low: 5 };

export function computeGrade(input: {
  vulnSeverities: (Severity | null)[];
  checks: SecurityCheck[];
  uptime24h: number | null;
}): Grade {
  let score = 100;
  for (const s of input.vulnSeverities) score -= VULN_WEIGHT[s ?? "low"] ?? 5;
  for (const c of input.checks) {
    if (c.result === "fail") score -= c.check_id === "core_checksums" ? 15 : 5;
    else if (c.result === "warn") score -= 2;
  }
  if (input.uptime24h !== null && input.uptime24h < 99) score -= 5;
  score = Math.max(0, score);
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
  return { grade, score };
}
