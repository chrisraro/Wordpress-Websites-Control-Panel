import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { checkSite } from "@/services/security/uptime";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createServiceSupabase } from "@/lib/supabase/server";
import type { UptimeRow } from "@/services/security/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  return NextResponse.json({ ok: true, sites: rows.length, down: rows.filter((r) => !r.ok).length });
}

export const POST = run;
export const GET = run;
