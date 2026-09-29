import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { checkSite } from "@/services/security/uptime";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createServiceSupabase } from "@/lib/supabase/server";
import type { UptimeRow } from "@/services/security/types";
import { runScheduledAlerts, type AlertRunResult } from "@/services/alerts/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Alert error text returned in the JSON body is capped; details go to the log. */
const ALERT_ERROR_MAX = 200;

/**
 * Alerting runs after the uptime rows are stored, so it sees this run's
 * checks. It must never fail the uptime route: any error is logged and
 * reported in the body, and the route still answers 200.
 */
async function alertsSafely(db: SupabaseClient): Promise<AlertRunResult> {
  try {
    return await runScheduledAlerts(db);
  } catch (e) {
    console.error("uptime: alerting failed", e);
    const message = e instanceof Error ? e.message : "alerting failed";
    return { sent: 0, error: message.slice(0, ALERT_ERROR_MAX) };
  }
}

async function run(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = createServiceSupabase();
  const sites = (await supabaseSitesRepo(db).listSites()).filter((s) => s.status !== "disabled");
  const rows: UptimeRow[] = await Promise.all(
    sites.map(async (s) => ({ site_id: s.id, ...(await checkSite(s.url)) })),
  );
  await supabaseSecurityRepo(db).insertUptime(rows);
  const alerts = await alertsSafely(db);
  return NextResponse.json({ ok: true, sites: rows.length, down: rows.filter((r) => !r.ok).length, alerts });
}

export const POST = run;
export const GET = run;
