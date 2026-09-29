import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeLastBackup } from "@/services/backup/summary";

// The site page's backup line (from the latest snapshot's `backup` field)
// and its "Back up now" button (backupNowAction -> startBackup).

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePathMock(p) }));
const createServiceSupabaseMock = vi.fn(() => ({}));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: () => Promise.resolve({ id: "u1", email: "u1@example.com" }),
  createServiceSupabase: () => createServiceSupabaseMock(),
}));

const DENIED = { ok: false, error: "You do not have permission to do that." };
const checkPermissionMock = vi.fn();
const checkSiteAccessMock = vi.fn();
vi.mock("@/lib/authz/server", () => ({
  checkPermission: (...a: unknown[]) => checkPermissionMock(...a),
  checkSiteAccess: (...a: unknown[]) => checkSiteAccessMock(...a),
  isDenied: (x: unknown): boolean =>
    typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false,
}));

const insertActivityMock = vi.fn();
vi.mock("@/services/sites/repo", () => ({
  supabaseSitesRepo: () => ({ tag: "sites", insertActivity: (e: unknown) => insertActivityMock(e) }),
}));
vi.mock("@/lib/mcp/client", () => ({ createSiteMcpClient: () => { throw new Error("no network"); } }));

const startBackupMock = vi.fn();
vi.mock("@/services/backup/gate", () => ({
  startBackup: (...a: unknown[]) => startBackupMock(...a),
}));

import { backupNowAction } from "@/app/(dashboard)/sites/[id]/backup-actions";

const SITE_ID = "1b6e3d4f-5c7e-4a92-8d3b-6f4c2a9e7b51";
const VIEWER = { id: "u1", permissions: new Set(["wp_toolkit.manage"]), grants: new Map() };
const NOW = Date.parse("2026-09-29T12:00:00Z");
const secsAgo = (s: number) => Math.floor(NOW / 1000) - s;

describe("describeLastBackup", () => {
  it("says nothing when the snapshot never measured it", () => {
    expect(describeLastBackup(undefined, NOW)).toBeNull();
  });

  it("names a missing backup plugin", () => {
    expect(describeLastBackup(null, NOW)).toEqual({ text: "No backup plugin", tone: "warn" });
  });

  it("flags a failed last run", () => {
    expect(describeLastBackup({ plugin: "updraftplus", last_backup_time: secsAgo(60), success: false }, NOW))
      .toEqual({ text: "Last backup failed", tone: "bad" });
  });

  it("gives a relative time for a successful run", () => {
    const at = (s: number) =>
      describeLastBackup({ plugin: "updraftplus", last_backup_time: secsAgo(s), success: true }, NOW)?.text;
    expect(at(30)).toBe("just now (UpdraftPlus)");
    expect(at(5 * 60)).toBe("5 minutes ago (UpdraftPlus)");
    expect(at(3600)).toBe("1 hour ago (UpdraftPlus)");
    expect(at(3 * 3600)).toBe("3 hours ago (UpdraftPlus)");
    expect(at(26 * 3600)).toBe("1 day ago (UpdraftPlus)");
    expect(at(9 * 86400)).toBe("9 days ago (UpdraftPlus)");
  });

  it("marks a successful backup older than the 6-hour pre-update window as stale", () => {
    const fresh = describeLastBackup({ plugin: "updraftplus", last_backup_time: secsAgo(3600), success: true }, NOW);
    const stale = describeLastBackup({ plugin: "updraftplus", last_backup_time: secsAgo(7 * 3600), success: true }, NOW);
    expect(fresh?.tone).toBe("good");
    expect(stale?.tone).toBe("idle");
  });

  it("says so when UpdraftPlus has never run", () => {
    expect(describeLastBackup({ plugin: "updraftplus", last_backup_time: null, success: null }, NOW))
      .toEqual({ text: "None yet (UpdraftPlus)", tone: "warn" });
  });
});

beforeEach(() => {
  checkPermissionMock.mockReset().mockResolvedValue(VIEWER);
  checkSiteAccessMock.mockReset().mockResolvedValue(VIEWER);
  startBackupMock.mockReset().mockResolvedValue(undefined);
  insertActivityMock.mockReset().mockResolvedValue(undefined);
  revalidatePathMock.mockReset();
  createServiceSupabaseMock.mockClear();
});

describe("backupNowAction", () => {
  it("is refused without wp_toolkit.manage, before touching the site", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    expect(await backupNowAction(SITE_ID, null)).toEqual(DENIED);
    expect(checkPermissionMock).toHaveBeenCalledWith("wp_toolkit.manage");
    expect(startBackupMock).not.toHaveBeenCalled();
    expect(createServiceSupabaseMock).not.toHaveBeenCalled();
  });

  it("is refused without a manage grant on the site", async () => {
    checkSiteAccessMock.mockResolvedValue(DENIED);
    expect(await backupNowAction(SITE_ID, null)).toEqual(DENIED);
    expect(checkSiteAccessMock).toHaveBeenCalledWith(SITE_ID, "manage");
    expect(startBackupMock).not.toHaveBeenCalled();
  });

  it("rejects a site id that is not a uuid", async () => {
    const r = await backupNowAction("../../etc", null);
    expect(r.ok).toBe(false);
    expect(checkSiteAccessMock).not.toHaveBeenCalled();
    expect(startBackupMock).not.toHaveBeenCalled();
  });

  it("starts the backup, logs it and refreshes the page", async () => {
    const r = await backupNowAction(SITE_ID, null);
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/backup started/i) });
    expect(startBackupMock).toHaveBeenCalledWith(expect.objectContaining({ sites: expect.objectContaining({ tag: "sites" }) }), SITE_ID);
    expect(insertActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "u1", site_id: SITE_ID, action: "site.backup.request" }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith(`/sites/${SITE_ID}`);
  });

  it("turns a site failure into a friendly error and logs nothing", async () => {
    startBackupMock.mockRejectedValue(new Error("Could not start the pre-update backup: UpdraftPlus is not active"));
    const r = await backupNowAction(SITE_ID, null);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/UpdraftPlus is not active/);
    expect(insertActivityMock).not.toHaveBeenCalled();
  });
});

describe("the site page shows the backup line and button", () => {
  const page = readFileSync(
    join(__dirname, "..", "src", "app", "(dashboard)", "sites", "[id]", "page.tsx"), "utf8",
  );

  it("reads the snapshot's backup field through describeLastBackup", () => {
    expect(page).toMatch(/describeLastBackup\(inv\?\.backup/);
    expect(page).toContain(">Last backup<");
  });

  it("offers Back up now only to viewers who can manage the toolkit on this site", () => {
    const idx = page.indexOf("backupNow");
    expect(idx).toBeGreaterThan(-1);
    expect(page).toMatch(/canManageToolkit && inv\?\.backup[\s\S]{0,400}label="Back up now"/);
  });
});
