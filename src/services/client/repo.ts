import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseReportsRepo } from "@/services/reports/repo";
import type { CareCounter, ClientEvidenceDeps, ClientEvidenceReader } from "./summary";

/**
 * Supabase implementations for the client home's evidence.
 *
 * `viewerDb` MUST be the client from readDbFor(viewer) -- for a client that
 * is the user-scoped client, and RLS (0008: uptime_checks_read, reports_read,
 * both has_site_access(site_id)) is what scopes these reads.
 *
 * `serviceDb` is the service role and bypasses RLS. It is used for exactly
 * one thing: head-only counts on activity_log, which clients cannot SELECT
 * (activity_log_select_staff_only). Head requests return a count and no
 * rows, so no actor id, detail or error text can leave this function. The
 * per-site grant check lives in loadClientEvidence, which is the only caller.
 */

/** Actions that count as maintenance done for the client (see manage/service.ts, marketplace/install.ts). */
const MANAGE_ACTION_PATTERN = "site.manage.%";
const PLUGIN_INSTALL_ACTION = "site.plugin_install";

export function supabaseClientEvidenceReader(viewerDb: SupabaseClient): ClientEvidenceReader {
  const reports = supabaseReportsRepo(viewerDb);
  const countChecks = async (siteId: string, sinceIso: string, okOnly: boolean): Promise<number> => {
    let q = viewerDb.from("uptime_checks").select("id", { count: "exact", head: true })
      .eq("site_id", siteId).gte("checked_at", sinceIso);
    if (okOnly) q = q.eq("ok", true);
    const { count, error } = await q;
    if (error || count === null) throw new Error("uptime count unavailable");
    return count;
  };

  return {
    async uptimeSince(siteId, sinceIso) {
      // Two head counts rather than fetching rows: a 5-minute sweep is
      // ~8,640 rows a month per site, well past PostgREST's row cap.
      const [total, ok, first] = await Promise.all([
        countChecks(siteId, sinceIso, false),
        countChecks(siteId, sinceIso, true),
        viewerDb.from("uptime_checks").select("checked_at")
          .eq("site_id", siteId).gte("checked_at", sinceIso)
          .order("checked_at", { ascending: true }).limit(1).maybeSingle(),
      ]);
      if (first.error) throw new Error("uptime window unavailable");
      return { total, ok, firstIso: (first.data?.checked_at as string | undefined) ?? null };
    },

    async latestSsl(siteId, sinceIso) {
      // The newest check that actually measured the certificate: a check
      // that failed to connect records null, which is not a reading.
      const { data, error } = await viewerDb.from("uptime_checks")
        .select("ssl_days_remaining,checked_at")
        .eq("site_id", siteId).gte("checked_at", sinceIso)
        .not("ssl_days_remaining", "is", null)
        .order("checked_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error("ssl reading unavailable");
      if (!data || typeof data.ssl_days_remaining !== "number") return null;
      return { days: data.ssl_days_remaining, checkedAtIso: data.checked_at as string };
    },

    async latestReport(siteId) {
      const [newest] = await reports.listForSite(siteId, 1);
      return newest ?? null;
    },
  };
}

export function supabaseCareCounter(serviceDb: SupabaseClient): CareCounter {
  const count = async (siteId: string, sinceIso: string, action: { like?: string; eq?: string }) => {
    let q = serviceDb.from("activity_log").select("id", { count: "exact", head: true })
      .eq("site_id", siteId).gte("at", sinceIso).eq("detail->>ok", "true");
    if (action.like) q = q.like("action", action.like);
    if (action.eq) q = q.eq("action", action.eq);
    const { count: n, error } = await q;
    // Generic on purpose: nothing from the audit table travels further.
    if (error || n === null) throw new Error("care count unavailable");
    return n;
  };
  return {
    async countCompleted(siteId, sinceIso) {
      const [manage, installs] = await Promise.all([
        count(siteId, sinceIso, { like: MANAGE_ACTION_PATTERN }),
        count(siteId, sinceIso, { eq: PLUGIN_INSTALL_ACTION }),
      ]);
      return manage + installs;
    },
  };
}

export function supabaseClientEvidenceDeps(
  viewerDb: SupabaseClient, serviceDb: SupabaseClient,
): ClientEvidenceDeps {
  return { reader: supabaseClientEvidenceReader(viewerDb), care: supabaseCareCounter(serviceDb) };
}
