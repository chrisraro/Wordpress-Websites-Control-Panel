import { describe, expect, it } from "vitest";
import { enqueueBulk, splitEligible, toManageAction } from "@/services/bulk/service";
import type { BulkDeps } from "@/services/bulk/service";
import type { InventoryPayload } from "@/services/inventory/types";
import type { JobsRepo } from "@/services/jobs/repo";
import type { SitesRepo } from "@/services/sites/repo";

const inv = (over: Partial<InventoryPayload> = {}): InventoryPayload => ({
  collected_at: "2026-08-29T00:00:00.000Z",
  wp_version: "7.1",
  php_version: "8.3",
  admin_url: "https://x/wp-admin/",
  core_update: null,
  plugins: [
    { file: "a/a.php", name: "a", version: "1", status: "active", update: "available", update_version: "2" },
    { file: "b/b.php", name: "b", version: "1", status: "inactive", update: "none" },
  ],
  themes: [
    { name: "child", template: "parent", version: "1", status: "active", update: "none" },
    { name: "parent", template: "parent", version: "1", status: "inactive", update: "available", update_version: "2" },
    { name: "spare", template: "spare", version: "1", status: "inactive", update: "none" },
  ],
  admin_users: [],
  ...over,
});

describe("splitEligible — plugins", () => {
  it("excludes an active plugin from delete, with a reason", () => {
    const s = splitEligible("delete", "plugin", inv(), ["a/a.php", "b/b.php"]);
    expect(s.included.map((i) => i.id)).toEqual(["b/b.php"]);
    expect(s.excluded[0].reason).toMatch(/active/i);
  });

  it("excludes a plugin with no update from update", () => {
    const s = splitEligible("update", "plugin", inv(), ["a/a.php", "b/b.php"]);
    expect(s.included.map((i) => i.id)).toEqual(["a/a.php"]);
  });

  it("excludes an already-active plugin from activate", () => {
    const s = splitEligible("activate", "plugin", inv(), ["a/a.php", "b/b.php"]);
    expect(s.included.map((i) => i.id)).toEqual(["b/b.php"]);
  });

  it("excludes an id with no matching plugin in the inventory, with a reason", () => {
    const s = splitEligible("update", "plugin", inv(), ["ghost/ghost.php"]);
    expect(s.included).toEqual([]);
    expect(s.excluded).toEqual([
      { id: "ghost/ghost.php", label: "ghost/ghost.php", reason: "No longer installed." },
    ]);
  });
});

describe("splitEligible — themes", () => {
  it("excludes the parent of the active theme from delete", () => {
    const s = splitEligible("delete", "theme", inv(), ["parent", "spare"]);
    expect(s.included.map((i) => i.id)).toEqual(["spare"]);
    expect(s.excluded[0].reason).toMatch(/parent/i);
  });

  it("keeps the delete reason from the theme safety gate", () => {
    const s = splitEligible("delete", "theme", inv(), ["child"]);
    expect(s.included).toEqual([]);
    expect(s.excluded[0].reason).toMatch(/active/i);
  });

  it("excludes every theme from deactivate — themes are switched, not deactivated", () => {
    const s = splitEligible("deactivate", "theme", inv(), ["spare"]);
    expect(s.included).toEqual([]);
    expect(s.excluded).toEqual([
      { id: "spare", label: "spare", reason: "Themes are switched, not deactivated." },
    ]);
  });

  it("excludes an id with no matching theme in the inventory, with a reason", () => {
    const s = splitEligible("update", "theme", inv(), ["ghost"]);
    expect(s.included).toEqual([]);
    expect(s.excluded).toEqual([{ id: "ghost", label: "ghost", reason: "No longer installed." }]);
  });
});

describe("toManageAction", () => {
  it("maps each bulk kind onto the matching manage action", () => {
    expect(toManageAction("delete", "plugin", "a/a.php")).toEqual({ kind: "delete_plugin", file: "a/a.php" });
    expect(toManageAction("update", "theme", "spare")).toEqual({ kind: "update_theme", slug: "spare" });
    expect(toManageAction("activate", "theme", "spare")).toEqual({ kind: "activate_theme", slug: "spare" });
  });

  it("throws for (deactivate, theme) — themes are switched, never deactivated", () => {
    expect(() => toManageAction("deactivate", "theme", "spare")).toThrow();
  });
});

describe("enqueueBulk", () => {
  function fakeDeps() {
    const jobsInserted: Array<{
      type: string; site_id?: string | null; payload?: Record<string, unknown>; batch_id?: string | null;
    }> = [];
    const activity: Array<Record<string, unknown>> = [];
    const jobs = {
      async insert(job: Record<string, unknown>) {
        jobsInserted.push(job as (typeof jobsInserted)[number]);
        return { id: `job-${jobsInserted.length}` };
      },
    } as unknown as JobsRepo;
    const sites = {
      async insertActivity(entry: Record<string, unknown>) { activity.push(entry); },
    } as unknown as SitesRepo;
    const deps: BulkDeps = { jobs, sites };
    return { deps, jobsInserted, activity };
  }

  it("inserts one job per eligible item, all sharing the same batch_id", async () => {
    const f = fakeDeps();
    const res = await enqueueBulk(f.deps, "site-1", "user-1", "update", "plugin", inv(), ["a/a.php", "b/b.php"]);
    expect(res.batchId).not.toBeNull();
    expect(f.jobsInserted).toHaveLength(1);
    expect(f.jobsInserted[0]).toMatchObject({
      type: "bulk_manage", site_id: "site-1", batch_id: res.batchId,
      payload: { kind: "update", target: "plugin", id: "a/a.php", label: "a", actor: "user-1" },
    });
  });

  it("produces no jobs for ineligible items", async () => {
    const f = fakeDeps();
    await enqueueBulk(f.deps, "site-1", "user-1", "update", "plugin", inv(), ["b/b.php"]);
    expect(f.jobsInserted).toHaveLength(0);
  });

  it("returns batchId: null and inserts nothing when nothing is eligible", async () => {
    const f = fakeDeps();
    const res = await enqueueBulk(f.deps, "site-1", "user-1", "update", "plugin", inv(), ["b/b.php"]);
    expect(res.batchId).toBeNull();
    expect(f.jobsInserted).toHaveLength(0);
    expect(f.activity).toHaveLength(0);
  });

  it("still reports excluded items with reasons even when some items are eligible", async () => {
    const f = fakeDeps();
    const res = await enqueueBulk(f.deps, "site-1", "user-1", "update", "plugin", inv(), ["a/a.php", "b/b.php"]);
    expect(res.split.included.map((i) => i.id)).toEqual(["a/a.php"]);
    expect(res.split.excluded).toEqual([
      { id: "b/b.php", label: "b", reason: "Already up to date." },
    ]);
  });
});
