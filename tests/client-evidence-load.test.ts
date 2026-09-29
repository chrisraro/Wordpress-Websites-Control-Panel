import { describe, expect, it, vi } from "vitest";
import { loadClientEvidence, monthStartIso, type ClientEvidenceDeps } from "@/services/client/summary";
import type { Viewer } from "@/lib/authz/decide";

const NOW = Date.parse("2026-09-29T12:00:00Z");

const clientViewer = (grants: Record<string, "read" | "manage">): Viewer => ({
  id: "u1", email: "c@example.com", role: "client",
  permissions: new Set(["reports.generate"]) as Viewer["permissions"],
  grants: new Map(Object.entries(grants)),
});

function deps(over: Partial<{
  reader: Partial<ClientEvidenceDeps["reader"]>; care: Partial<ClientEvidenceDeps["care"]>;
}> = {}): ClientEvidenceDeps {
  return {
    reader: {
      uptimeSince: vi.fn(async () => ({ total: 10, ok: 10, firstIso: "2026-08-30T12:00:00Z" })),
      latestSsl: vi.fn(async () => ({ days: 60, checkedAtIso: "2026-09-29T11:55:00Z" })),
      latestReport: vi.fn(async () => null),
      ...over.reader,
    },
    care: { countCompleted: vi.fn(async () => 4), ...over.care },
  };
}

describe("monthStartIso", () => {
  it("is the first instant of the current calendar month (UTC)", () => {
    expect(monthStartIso(NOW)).toBe("2026-09-01T00:00:00.000Z");
    expect(monthStartIso(Date.parse("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("loadClientEvidence", () => {
  it("reads every piece for a granted site", async () => {
    const d = deps();
    const e = await loadClientEvidence(d, clientViewer({ s1: "read" }), "s1", { now: NOW, backup: undefined });
    expect(e.uptime).toEqual({ total: 10, ok: 10, firstIso: "2026-08-30T12:00:00Z" });
    expect(e.ssl?.days).toBe(60);
    expect(e.care).toBe(4);
    expect(d.reader.uptimeSince).toHaveBeenCalledWith("s1", new Date(NOW - 30 * 86_400_000).toISOString());
    expect(d.care.countCompleted).toHaveBeenCalledWith("s1", "2026-09-01T00:00:00.000Z");
  });

  it("never runs the service-role count for a site the viewer is not granted", async () => {
    // The care count is the one read that bypasses RLS, so the grant check
    // here is the whole boundary for it.
    const d = deps();
    const e = await loadClientEvidence(d, clientViewer({ other: "read" }), "s1", { now: NOW, backup: undefined });
    expect(d.care.countCompleted).not.toHaveBeenCalled();
    expect(d.reader.uptimeSince).not.toHaveBeenCalled();
    expect(e.care).toBeNull();
    expect(e.uptime).toBeNull();
  });

  it("turns a failed read into unknown for that line only, never an error", async () => {
    const d = deps({
      care: { countCompleted: vi.fn(async () => { throw new Error("permission denied for actor 1234"); }) },
      reader: { latestSsl: vi.fn(async () => { throw new Error("boom"); }) },
    });
    const e = await loadClientEvidence(d, clientViewer({ s1: "read" }), "s1", { now: NOW, backup: undefined });
    expect(e.care).toBeNull();
    expect(e.ssl).toBeNull();
    expect(e.uptime?.total).toBe(10);
    expect(JSON.stringify(e)).not.toMatch(/actor|permission|boom/);
  });

  it("passes the snapshot's backup status through untouched", async () => {
    const backup = { plugin: "updraftplus" as const, last_backup_time: 1, success: true };
    const e = await loadClientEvidence(deps(), clientViewer({ s1: "read" }), "s1", { now: NOW, backup });
    expect(e.backup).toBe(backup);
  });
});
