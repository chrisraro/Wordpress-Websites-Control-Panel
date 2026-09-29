import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The core update runs inline (not queued), so it cannot wait for a backup.
// manageAction checks backupReadyForInlineUpdate before update_core and
// refuses with its reason, unless the confirm dialog's secondary button
// posted backup=skip ("Update core without a backup"). Other actions never
// check.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: () => Promise.resolve({ id: "u1", email: "u1@example.com" }),
  createServiceSupabase: () => ({}),
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

vi.mock("@/services/sites/repo", () => ({ supabaseSitesRepo: () => ({ tag: "sites" }) }));
vi.mock("@/services/jobs/repo", () => ({ supabaseJobsRepo: () => ({}) }));
vi.mock("@/lib/mcp/client", () => ({ createSiteMcpClient: () => { throw new Error("no network"); } }));

const manageSiteMock = vi.fn();
vi.mock("@/services/manage/service", () => ({
  manageSite: (...a: unknown[]) => manageSiteMock(...a),
}));

const backupReadyMock = vi.fn();
vi.mock("@/services/backup/gate", () => ({
  backupReadyForInlineUpdate: (...a: unknown[]) => backupReadyMock(...a),
}));

import { manageAction } from "@/app/(dashboard)/sites/[id]/manage-actions";

const VIEWER = { id: "u1", permissions: new Set(["wp_toolkit.manage"]), grants: new Map() };
const CORE = { kind: "update_core" } as const;

function fd(entries: [string, string][] = []): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

beforeEach(() => {
  checkPermissionMock.mockReset().mockResolvedValue(VIEWER);
  checkSiteAccessMock.mockReset().mockResolvedValue(VIEWER);
  manageSiteMock.mockReset().mockResolvedValue({ ok: true, output: "Updated" });
  backupReadyMock.mockReset().mockResolvedValue({ ready: true });
});

describe("manageAction update_core backup check", () => {
  it("updates when a fresh backup exists", async () => {
    expect(await manageAction("s1", CORE, null, fd())).toEqual({ ok: true });
    expect(backupReadyMock).toHaveBeenCalledWith(expect.objectContaining({ sites: { tag: "sites" } }), "s1");
    expect(manageSiteMock).toHaveBeenCalledTimes(1);
  });

  it("refuses with the gate's reason and never runs the update", async () => {
    backupReadyMock.mockResolvedValue({ ready: false, reason: "No successful backup in the last 6 hours." });
    const r = await manageAction("s1", CORE, null, fd());
    expect(r).toEqual({ ok: false, error: "No successful backup in the last 6 hours." });
    expect(manageSiteMock).not.toHaveBeenCalled();
  });

  it("skips the check when the operator chose Update core without a backup", async () => {
    backupReadyMock.mockResolvedValue({ ready: false, reason: "No backup plugin" });
    expect(await manageAction("s1", CORE, null, fd([["backup", "skip"]]))).toEqual({ ok: true });
    expect(backupReadyMock).not.toHaveBeenCalled();
    expect(manageSiteMock).toHaveBeenCalledTimes(1);
  });

  it("still checks when called without a form at all", async () => {
    backupReadyMock.mockResolvedValue({ ready: false, reason: "No backup plugin" });
    expect(await manageAction("s1", CORE)).toMatchObject({ ok: false });
    expect(manageSiteMock).not.toHaveBeenCalled();
  });

  it("turns an unreachable site into a friendly error", async () => {
    backupReadyMock.mockRejectedValue(new Error("fetch failed"));
    const r = await manageAction("s1", CORE, null, fd());
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(manageSiteMock).not.toHaveBeenCalled();
  });

  it("does not check backups for other actions", async () => {
    await manageAction("s1", { kind: "flush_cache" }, null, fd());
    expect(backupReadyMock).not.toHaveBeenCalled();
  });

  it("checks nothing when the caller is denied", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    expect(await manageAction("s1", CORE, null, fd())).toEqual(DENIED);
    expect(backupReadyMock).not.toHaveBeenCalled();
  });
});

describe("the core update dialog offers a secondary, unbacked update", () => {
  const page = readFileSync(
    join(__dirname, "..", "src", "app", "(dashboard)", "sites", "[id]", "page.tsx"), "utf8",
  );
  const form = readFileSync(
    join(__dirname, "..", "src", "app", "(dashboard)", "sites", "[id]", "action-form.tsx"), "utf8",
  );

  it("the Update core form carries the secondary button posting backup=skip", () => {
    const block = page.slice(page.indexOf("action={updateCore}"), page.indexOf("action={updateCore}") + 1200);
    expect(block).toContain("Update core without a backup");
    expect(block).toMatch(/secondaryConfirm=\{\{[^}]*name: "backup"[^}]*value: "skip"/);
  });

  it("ManageForm submits the secondary choice as the form's submitter", () => {
    expect(form).toMatch(/requestSubmit\(secondaryRef\.current\)/);
  });
});
