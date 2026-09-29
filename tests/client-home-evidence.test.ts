import { describe, expect, it } from "vitest";
import { evidenceItems, type ClientSiteRow } from "@/app/(dashboard)/dashboard/client-home";
import type { SiteRow } from "@/services/sites/types";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const site: SiteRow = {
  id: "s1", name: "Azalea Boracay", url: "https://azaleaboracay.com",
  status: "connected", client_label: null, capabilities: { abilities: [] },
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};
const row = (over: Partial<ClientSiteRow> = {}): ClientSiteRow => ({
  site, severity: "ok", lastCheckedIso: "2026-09-29T02:00:00Z", ...over,
});

describe("evidenceItems", () => {
  it("shows nothing extra when no evidence was loaded", () => {
    expect(evidenceItems(row(), NOW)).toEqual([]);
  });

  it("orders uptime, SSL, backups, maintenance", () => {
    const items = evidenceItems(row({
      evidence: {
        uptime: { total: 8640, ok: 8640, firstIso: "2026-08-30T12:00:00Z" },
        ssl: { days: 60, checkedAtIso: "2026-09-29T11:55:00Z" },
        backup: { plugin: "updraftplus", last_backup_time: Math.floor(NOW / 1000) - 3600, success: true },
        care: 2,
        latestReport: null,
      },
    }), NOW);
    expect(items.map((i) => i.value)).toEqual([
      "100%", "Valid for 60 more days", "Backed up today", "2 maintenance updates this month",
    ]);
  });

  it("leaves out every unknown line but keeps 'Not measured yet' for uptime", () => {
    const items = evidenceItems(row({
      lastCheckedIso: null,
      evidence: { uptime: { total: 0, ok: 0, firstIso: null }, ssl: null, backup: undefined, care: 0, latestReport: null },
    }), NOW);
    expect(items.map((i) => i.value)).toEqual(["Not measured yet"]);
  });

  it("never puts the backup tool's name on the card", () => {
    const items = evidenceItems(row({
      evidence: {
        uptime: null, ssl: null, care: null, latestReport: null,
        backup: { plugin: "updraftplus", last_backup_time: null, success: null },
      },
    }), NOW);
    expect(JSON.stringify(items).toLowerCase()).not.toContain("updraft");
    expect(items.map((i) => i.value)).toEqual(["No recent backup"]);
  });
});
