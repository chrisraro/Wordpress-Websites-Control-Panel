import { randomBytes, randomUUID } from "node:crypto";
import { renderToBuffer } from "@react-pdf/renderer";
import { gatherReportData, type GatherDeps } from "./gather";
import { ReportDocument } from "./document";
import type { ReportsRepo, ReportRow, ReportStorage } from "./repo";
import type { ReportData, ReportSection } from "./types";

export function newShareToken(): string {
  return randomBytes(16).toString("hex");
}

export interface GenerateDeps extends GatherDeps {
  reports: ReportsRepo;
  storage: ReportStorage;
  /** Injected in tests; production renders with @react-pdf/renderer. */
  render?: (data: ReportData) => Promise<Uint8Array>;
}

async function renderPdf(data: ReportData): Promise<Uint8Array> {
  const buffer = await renderToBuffer(ReportDocument(data));
  return new Uint8Array(buffer);
}

export async function generateReport(
  deps: GenerateDeps, siteId: string, sections: ReportSection[],
  periodDays: number, auto: boolean,
): Promise<{ report: ReportRow; bytes: number }> {
  if (sections.length === 0) throw new Error("Choose at least one report section");

  const data = await gatherReportData(deps, siteId, sections, periodDays);
  const pdf = await (deps.render ?? renderPdf)(data);

  // Upload before inserting: a recorded report must always have a file behind it.
  const path = `${siteId}/${randomUUID()}.pdf`;
  await deps.storage.upload(path, pdf);

  const report = await deps.reports.insert({
    site_id: siteId,
    sections,
    period_start: data.meta.periodStart,
    period_end: data.meta.periodEnd,
    storage_path: path,
    share_token: newShareToken(),
    auto,
  });
  return { report, bytes: pdf.length };
}
