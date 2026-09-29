import { canAccessSite, type Viewer } from "@/lib/authz/decide";
import type { BackupStatus } from "@/services/inventory/types";
import {
  monthStartIso, UPTIME_WINDOW_DAYS, type LatestReport, type SslReading, type UptimeTally,
} from "./format";

export { monthStartIso };

/**
 * Loads the evidence behind a client's site card.
 *
 * Two readers, on purpose:
 *
 *   - `reader` goes through the viewer's own client (readDbFor -> the
 *     user-scoped Supabase client for a client), so RLS from 0008 is the
 *     boundary: uptime_checks and reports are readable at a 'read' grant.
 *   - `care` counts activity_log, which RLS keeps staff-only
 *     (activity_log_select_staff_only). It runs on the service role, so the
 *     grant check below is the ENTIRE boundary for it, and its contract is a
 *     bare number -- never rows, actor ids or error text.
 *
 * Every piece fails independently to null ("unknown"), which the formatters
 * turn into an omitted line. A client never sees an error from here.
 */

export interface ClientEvidenceReader {
  uptimeSince(siteId: string, sinceIso: string): Promise<UptimeTally>;
  latestSsl(siteId: string, sinceIso: string): Promise<SslReading | null>;
  latestReport(siteId: string): Promise<LatestReport | null>;
}

export interface CareCounter {
  /** Successful maintenance actions on the site since `sinceIso`. A count only. */
  countCompleted(siteId: string, sinceIso: string): Promise<number>;
}

export interface ClientEvidenceDeps {
  reader: ClientEvidenceReader;
  care: CareCounter;
}

export interface ClientEvidence {
  uptime: UptimeTally | null;
  ssl: SslReading | null;
  backup: BackupStatus | null | undefined;
  care: number | null;
  latestReport: LatestReport | null;
}

const UNKNOWN: ClientEvidence = { uptime: null, ssl: null, backup: undefined, care: null, latestReport: null };

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    // Deliberately swallowed: this is a client-facing screen and the line
    // is simply omitted. The same reads fail loudly on staff surfaces.
    return null;
  }
}

export async function loadClientEvidence(
  deps: ClientEvidenceDeps,
  viewer: Viewer,
  siteId: string,
  opts: { now: number; backup: BackupStatus | null | undefined },
): Promise<ClientEvidence> {
  if (!canAccessSite(viewer, siteId, "read")) return UNKNOWN;

  const windowStart = new Date(opts.now - UPTIME_WINDOW_DAYS * 86_400_000).toISOString();
  const [uptime, ssl, latestReport, care] = await Promise.all([
    orNull(() => deps.reader.uptimeSince(siteId, windowStart)),
    orNull(() => deps.reader.latestSsl(siteId, windowStart)),
    orNull(() => deps.reader.latestReport(siteId)),
    orNull(() => deps.care.countCompleted(siteId, monthStartIso(opts.now))),
  ]);
  return {
    uptime, ssl, backup: opts.backup, latestReport,
    care: Number.isInteger(care) && (care as number) >= 0 ? care : null,
  };
}
