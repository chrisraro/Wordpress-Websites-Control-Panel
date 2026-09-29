import { can, type Viewer } from "./decide";

/**
 * What a non-staff viewer sees in place of a job's `last_error`.
 *
 * `last_error` is raw worker output -- PHP fatals with host file paths,
 * upstream HTTP bodies, adapter internals -- which is diagnostic for the
 * agency's own staff and nobody else. A client with a read grant on a site
 * still needs to know *that* a job hit a problem, just not the internals.
 */
export const GENERIC_JOB_ERROR = "This job ran into a problem. Contact the OCS team for details.";

/**
 * Staff are the viewers who hold `sites.view_all` (admin/developer by
 * default). They see raw job diagnostics -- `last_error` and `attempts`.
 * Pure, like ./decide, so route handlers and MCP tools share one rule.
 */
export function canSeeJobDiagnostics(viewer: Viewer): boolean {
  return can(viewer, "sites.view_all");
}

/** A job's error as this viewer may see it: raw for staff, generic otherwise. */
export function jobErrorFor(viewer: Viewer, lastError: string | null | undefined): string | null {
  if (lastError === null || lastError === undefined || lastError === "") return lastError ?? null;
  return canSeeJobDiagnostics(viewer) ? lastError : GENERIC_JOB_ERROR;
}
