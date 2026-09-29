import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateReport, type GenerateDeps } from "@/services/reports/generate";
import { gatherReportData } from "@/services/reports/gather";
import { incompleteGradeNotice, type Grade } from "@/services/security/types";
import type { ReportRow, ReportsRepo, ReportStorage } from "@/services/reports/repo";
import type { SitesRepo } from "@/services/sites/repo";
import type { SecurityRepo } from "@/services/security/repo";
import type { SeoRepo } from "@/services/seo/repo";
import type { GeoGridRepo } from "@/services/geogrid/repo";
import type { SnapshotsRepo } from "@/services/inventory/repo";

// Audit 2026-09-29, still-open #2: the PDF and the /r/<token> page are what
// leave the building, so an incomplete security grade has to say so there
// too -- and the share page cannot recompute it later, so the report row
// keeps what the PDF was built from.

function deps(grade: Grade | null) {
  const inserted: Array<Record<string, unknown>> = [];
  const sites = {
    async getSite(id: string) {
      return { id, name: "Test Site", url: "https://test.example", status: "connected",
        client_label: null, capabilities: { abilities: [] }, created_at: "", updated_at: "" };
    },
  } as unknown as SitesRepo;
  const security = {
    async latestGrade() { return grade; },
    async openVulns() { return []; },
    async latestChecks() { return null; },
    async uptimeSummary() { return { latestOk: null, responseMs: null, sslDays: null, uptime24h: null }; },
  } as unknown as SecurityRepo;
  const reports = {
    async insert(row: Record<string, unknown>) {
      inserted.push(row);
      return { id: "rep-1", generated_at: "2026-09-29T00:00:00Z", ...row } as unknown as ReportRow;
    },
  } as unknown as ReportsRepo;
  const storage: ReportStorage = { async upload() {}, async download() { return new Uint8Array(); } };
  const d: GenerateDeps = {
    sites, security, reports, storage,
    seo: { async latestBySource() { return {}; } } as unknown as SeoRepo,
    geogrid: { async getConfigBySite() { return null; } } as unknown as GeoGridRepo,
    snapshots: { async latestSnapshot() { return null; } } as unknown as SnapshotsRepo,
    render: async () => new Uint8Array([1]),
  };
  return { d, inserted };
}

describe("incompleteGradeNotice", () => {
  it("says nothing for a complete or untracked grade", () => {
    expect(incompleteGradeNotice([])).toBeNull();
    expect(incompleteGradeNotice(undefined)).toBeNull();
    expect(incompleteGradeNotice(null)).toBeNull();
  });

  it("names every part that could not be checked and the cap", () => {
    const text = incompleteGradeNotice(["vuln_feed", "http_probes"])!;
    expect(text).toMatch(/incomplete/i);
    expect(text).toContain("Known vulnerabilities");
    expect(text).toContain("Public web checks");
    expect(text).toMatch(/at most C/);
  });
});

describe("report security coverage", () => {
  it("carries the grade's incomplete list into the security section", async () => {
    const { d } = deps({ grade: "C", score: 79, incomplete: ["core_checksums"] });
    const data = await gatherReportData(d, "site-1", ["security"], 30);
    expect(data.security).toMatchObject({ grade: "C", incomplete: ["core_checksums"] });
  });

  it("keeps an untracked grade as null, not as complete", async () => {
    const { d } = deps({ grade: "A", score: 95 });
    const data = await gatherReportData(d, "site-1", ["security"], 30);
    expect(data.security!.incomplete).toBeNull();
  });

  it("records the incomplete list on the report row for the share page", async () => {
    const { d, inserted } = deps({ grade: "C", score: 70, incomplete: ["vuln_feed"] });
    await generateReport(d, "site-1", ["security"], 30, false);
    expect(inserted[0].security_incomplete).toEqual(["vuln_feed"]);
  });

  it("records null when the report has no security section", async () => {
    const { d, inserted } = deps({ grade: "C", score: 70, incomplete: ["vuln_feed"] });
    await generateReport(d, "site-1", ["inventory"], 30, false);
    expect(inserted[0].security_incomplete).toBeNull();
  });
});

describe("0024 migration", () => {
  const SQL = readFileSync(
    new URL("../supabase/migrations/0024_report_share_expiry_and_coverage.sql", import.meta.url), "utf8",
  ).replace(/--.*$/gm, "");

  it("adds security_incomplete to reports, re-runnably and nullable", () => {
    expect(SQL).toMatch(/alter table reports\s+add column if not exists security_incomplete text\[\]/i);
    expect(SQL).not.toMatch(/security_incomplete text\[\][^,;]*not null/i);
  });
});
