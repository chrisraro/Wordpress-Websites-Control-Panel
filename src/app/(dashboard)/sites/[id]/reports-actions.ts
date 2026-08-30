"use server";

import { revalidatePath } from "next/cache";
import { generateReport } from "@/services/reports/generate";
import { supabaseReportsRepo, supabaseReportStorage } from "@/services/reports/repo";
import { parseSections } from "@/services/reports/types";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";
import { friendlySiteError } from "@/lib/mcp/errors";

function reportDeps(db: ReturnType<typeof createServiceSupabase>) {
  return {
    sites: supabaseSitesRepo(db),
    security: supabaseSecurityRepo(db),
    seo: supabaseSeoRepo(db),
    geogrid: supabaseGeoGridRepo(db),
    snapshots: supabaseSnapshotsRepo(db),
    reports: supabaseReportsRepo(db),
    storage: supabaseReportStorage(db),
  };
}

export async function generateReportAction(
  siteId: string,
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("reports.generate");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId);
  if (isDenied(site)) return site;
  if (!formData || typeof formData.getAll !== "function") {
    return { ok: false, error: "Form data missing — please resubmit" };
  }
  const sections = parseSections(formData.getAll("sections").map(String));
  if (sections.length === 0) return { ok: false, error: "Choose at least one section" };
  const periodDays = Number(String(formData.get("period_days") ?? "30"));
  if (!Number.isFinite(periodDays) || periodDays < 1 || periodDays > 365) {
    return { ok: false, error: "Period must be between 1 and 365 days" };
  }

  const db = createServiceSupabase();
  try {
    await generateReport(reportDeps(db), siteId, sections, periodDays, false);
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.report_generate",
      detail: { sections, period_days: periodDays },
    });
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Report generation failed" };
  }
  revalidatePath(`/sites/${siteId}/reports`);
  return { ok: true };
}

export async function revokeReportAction(
  siteId: string,
  reportId: string,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("reports.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId);
  if (isDenied(site)) return site;
  const db = createServiceSupabase();
  try {
    await supabaseReportsRepo(db).revoke(reportId, siteId);
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.report_revoke", detail: { report_id: reportId },
    });
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Could not revoke the link" };
  }
  revalidatePath(`/sites/${siteId}/reports`);
  return { ok: true };
}
