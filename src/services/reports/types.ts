export type ReportSection = "security" | "seo" | "geogrid" | "inventory";

export const REPORT_SECTIONS: ReportSection[] = ["security", "seo", "geogrid", "inventory"];

export function parseSections(raw: unknown): ReportSection[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((v): v is string => typeof v === "string"));
  return REPORT_SECTIONS.filter((s) => wanted.has(s));
}

export interface ReportMeta {
  siteName: string;
  siteUrl: string;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  sections: ReportSection[];
}

export interface SecuritySection {
  grade: string | null;
  score: number | null;
  openVulns: number;
  criticalVulns: number;
  failedChecks: Array<{ id: string; result: string }>;
  uptime24h: number | null;
  sslDays: number | null;
  scannedAt: string | null;
}

export interface SeoSection {
  auditScore: number | null;
  grade: string | null;
  failingFindings: Array<{ title: string; status: string }>;
  worstPages: Array<{ title: string; score: number | null }>;
  keywordsConnected: boolean;
  topKeywords: Array<{ keyword: string; clicks: number; position: number }>;
  psiMobile: number | null;
  psiDesktop: number | null;
  brands: Array<{ name: string; score: number | null }>;
  scannedAt: string | null;
}

export interface GeoGridSection {
  businessName: string | null;
  keywords: Array<{
    keyword: string;
    averageRank: number | null;
    coverage: number;
    /** Grid points that returned a real lookup result, whether or not they ranked. */
    measured: number;
    /** Total grid points in the run. `measured < total` is a coverage gap the PDF must disclose. */
    total: number;
    runAt: string;
  }>;
}

export interface InventorySection {
  wpVersion: string | null;
  phpVersion: string | null;
  pluginCount: number;
  pendingUpdates: number;
  coreUpdate: string | null;
  collectedAt: string | null;
}

export interface ReportData {
  meta: ReportMeta;
  security: SecuritySection | null;
  seo: SeoSection | null;
  geogrid: GeoGridSection | null;
  inventory: InventorySection | null;
}
