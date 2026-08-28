import { describe, it, expect } from "vitest";
import { generateReport, newShareToken, type GenerateDeps } from "@/services/reports/generate";
import type { ReportRow, ReportsRepo, ReportStorage } from "@/services/reports/repo";
import type { ReportData } from "@/services/reports/types";
import type { SitesRepo } from "@/services/sites/repo";
import type { SecurityRepo } from "@/services/security/repo";
import type { SeoRepo } from "@/services/seo/repo";
import type { GeoGridRepo } from "@/services/geogrid/repo";
import type { SnapshotsRepo } from "@/services/inventory/repo";

function fakes() {
  const uploaded: Array<{ path: string; bytes: number }> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const rendered: ReportData[] = [];

  const sites = {
    async getSite(id: string) {
      return id === "site-1"
        ? { id, name: "Test Site", url: "https://test.example", mcp_endpoint: "x",
            wp_username: "admin", status: "connected", client_label: null,
            capabilities: { abilities: [] }, created_at: "", updated_at: "" }
        : null;
    },
  } as unknown as SitesRepo;
  const security = {
    async latestGrade() { return null; },
    async openVulns() { return []; },
    async latestChecks() { return null; },
    async uptimeSummary() { return { latestOk: null, responseMs: null, sslDays: null, uptime24h: null }; },
  } as unknown as SecurityRepo;
  const seo = { async latestBySource() { return {}; } } as unknown as SeoRepo;
  const geogrid = {
    async getConfigBySite() { return null; },
    async latestPerKeyword() { return {}; },
  } as unknown as GeoGridRepo;
  const snapshots = { async latestSnapshot() { return null; } } as unknown as SnapshotsRepo;

  const reports: ReportsRepo = {
    async insert(row) {
      inserted.push(row);
      return { id: "rep-1", generated_at: "2026-08-28T00:00:00Z", ...row } as ReportRow;
    },
    async listForSite() { return []; },
    async getByToken() { return null; },
    async revoke() {},
    async autoExistsSince() { return false; },
  };
  const storage: ReportStorage = {
    async upload(path, pdf) { uploaded.push({ path, bytes: pdf.length }); },
    async download() { return new Uint8Array([1, 2, 3]); },
  };
  const render = async (data: ReportData) => {
    rendered.push(data);
    return new Uint8Array([0x25, 0x50, 0x44, 0x46]);   // "%PDF"
  };

  const deps: GenerateDeps = { sites, security, seo, geogrid, snapshots, reports, storage, render };
  return { deps, uploaded, inserted, rendered };
}

describe("newShareToken", () => {
  it("returns 32 hex characters that differ each call", () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("generateReport", () => {
  it("gathers, renders, uploads, and records the report", async () => {
    const f = fakes();
    const res = await generateReport(f.deps, "site-1", ["security", "inventory"], 30, false);

    expect(f.rendered).toHaveLength(1);
    expect(f.rendered[0].meta.siteName).toBe("Test Site");
    expect(f.rendered[0].security).not.toBeNull();
    expect(f.rendered[0].seo).toBeNull();

    expect(f.uploaded).toHaveLength(1);
    expect(f.uploaded[0].path).toMatch(/^site-1\/[0-9a-f-]{36}\.pdf$/);
    expect(f.uploaded[0].bytes).toBe(4);

    expect(f.inserted[0]).toMatchObject({
      site_id: "site-1", sections: ["security", "inventory"], auto: false,
    });
    expect(String(f.inserted[0].share_token)).toMatch(/^[0-9a-f]{32}$/);
    expect(f.inserted[0].storage_path).toBe(f.uploaded[0].path);

    expect(res.bytes).toBe(4);
    expect(res.report.id).toBe("rep-1");
  });

  it("marks automatic reports", async () => {
    const f = fakes();
    await generateReport(f.deps, "site-1", ["security"], 30, true);
    expect(f.inserted[0]).toMatchObject({ auto: true });
  });

  it("rejects an empty section list", async () => {
    const f = fakes();
    await expect(generateReport(f.deps, "site-1", [], 30, false)).rejects.toThrow(/section/i);
  });

  it("does not record a report when the upload fails", async () => {
    const f = fakes();
    f.deps.storage.upload = async () => { throw new Error("storage down"); };
    await expect(generateReport(f.deps, "site-1", ["security"], 30, false)).rejects.toThrow("storage down");
    expect(f.inserted).toHaveLength(0);
  });
});
