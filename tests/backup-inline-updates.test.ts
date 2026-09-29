import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ManageAction } from "@/services/manage/types";

// The owner's rule: back up before core AND plugin updates. Every inline
// update (core, one plugin, all plugins, one theme) runs immediately and
// cannot wait for a backup, so manageAction refuses each of them with
// backupReadyForInlineUpdate's reason unless the dialog's secondary
// "... without a backup" button posted backup=skip.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: () => Promise.resolve({ id: "u1", email: "u1@example.com" }),
  createServiceSupabase: () => ({}),
}));

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

function fd(entries: [string, string][] = []): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

const UPDATES: ManageAction[] = [
  { kind: "update_core" },
  { kind: "update_plugin", file: "akismet/akismet.php" },
  { kind: "update_all_plugins" },
  { kind: "update_theme", slug: "twentytwentyfour" },
];

const NOT_UPDATES: ManageAction[] = [
  { kind: "activate_plugin", file: "akismet/akismet.php" },
  { kind: "deactivate_plugin", file: "akismet/akismet.php" },
  { kind: "delete_plugin", file: "akismet/akismet.php" },
  { kind: "activate_theme", slug: "twentytwentyfour" },
  { kind: "delete_theme", slug: "twentytwentyfour" },
  { kind: "maintenance", enable: true },
  { kind: "flush_cache" },
  { kind: "flush_permalinks" },
];

beforeEach(() => {
  checkPermissionMock.mockReset().mockResolvedValue(VIEWER);
  checkSiteAccessMock.mockReset().mockResolvedValue(VIEWER);
  manageSiteMock.mockReset().mockResolvedValue({ ok: true, output: "Updated" });
  backupReadyMock.mockReset().mockResolvedValue({ ready: true });
});

describe.each(UPDATES.map((a) => [a.kind, a] as const))("manageAction %s backup check", (_kind, action) => {
  it("updates when a fresh backup exists", async () => {
    expect(await manageAction("s1", action, null, fd())).toEqual({ ok: true });
    expect(backupReadyMock).toHaveBeenCalledWith(expect.objectContaining({ sites: { tag: "sites" } }), "s1");
    expect(manageSiteMock).toHaveBeenCalledTimes(1);
  });

  it("refuses with the gate's reason and never runs the update", async () => {
    backupReadyMock.mockResolvedValue({ ready: false, reason: "No successful backup in the last 6 hours." });
    expect(await manageAction("s1", action, null, fd()))
      .toEqual({ ok: false, error: "No successful backup in the last 6 hours." });
    expect(manageSiteMock).not.toHaveBeenCalled();
  });

  it("skips the check when the form posts backup=skip", async () => {
    backupReadyMock.mockResolvedValue({ ready: false, reason: "No backup plugin" });
    expect(await manageAction("s1", action, null, fd([["backup", "skip"]]))).toEqual({ ok: true });
    expect(backupReadyMock).not.toHaveBeenCalled();
    expect(manageSiteMock).toHaveBeenCalledTimes(1);
  });

  it("still checks when called without a form, or with any other backup value", async () => {
    backupReadyMock.mockResolvedValue({ ready: false, reason: "No backup plugin" });
    expect(await manageAction("s1", action)).toMatchObject({ ok: false });
    expect(await manageAction("s1", action, null, fd([["backup", "SKIP"]]))).toMatchObject({ ok: false });
    expect(manageSiteMock).not.toHaveBeenCalled();
  });
});

describe("manageAction does not check backups for non-update actions", () => {
  it.each(NOT_UPDATES.map((a) => [a.kind, a] as const))("%s", async (_kind, action) => {
    backupReadyMock.mockResolvedValue({ ready: false, reason: "No backup plugin" });
    await manageAction("s1", action, null, fd());
    expect(backupReadyMock).not.toHaveBeenCalled();
    expect(manageSiteMock).toHaveBeenCalledTimes(1);
  });
});

describe("every inline update button offers the unbacked update as a secondary confirm", () => {
  const dir = join(__dirname, "..", "src", "app", "(dashboard)", "sites", "[id]");
  const read = (...p: string[]) => readFileSync(join(dir, ...p), "utf8");

  function formBlock(src: string, marker: string): string {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf("/>", src.indexOf("secondaryConfirm", at));
    return src.slice(at, end);
  }

  it.each([
    ["plugin table single-row Update", ["plugins", "plugin-table.tsx"], "action={update}", "Update without a backup"],
    ["Plugins tab inline Update all", ["plugins", "page.tsx"], "action={updateAll}", "Update all without a backup"],
    ["theme table single-row Update", ["themes", "theme-table.tsx"], "action={update}", "Update without a backup"],
  ] as const)("%s", (_name, path, marker, label) => {
    const block = formBlock(read(...path), marker);
    expect(block).toContain(label);
    expect(block).toMatch(/secondaryConfirm=\{\{[^}]*name: "backup"[^}]*value: "skip"/);
    // The block must still be the same form: no other ManageForm between.
    expect(block.slice(1)).not.toContain("<ManageForm");
  });
});
