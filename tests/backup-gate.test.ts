import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";
import { DeferJob, NonRetryableError } from "@/services/jobs/service";
import { backupReadyForInlineUpdate, gateOnBackup } from "@/services/backup/gate";
import { BACKUP_FRESH_MS, BACKUP_POLL_MS } from "@/services/backup/updraft";

const NOW = Date.parse("2026-09-29T04:00:00Z");
const sec = (ms: number) => Math.floor(ms / 1000);

interface SiteState { plugin: "updraftplus" | null; last: number | null; success: boolean | null; pending: boolean }

function site(state: SiteState) {
  const requested: number[] = [];
  const mock = new MockMcpClient({
    handler: (_name, args) => {
      const code = (args as { code: string }).code;
      const value = code.includes("wp_schedule_single_event")
        ? (requested.push(1), { ok: true, time: sec(NOW) })
        : { plugin: state.plugin, last_backup_time: state.last, success: state.success, pending: state.pending };
      return { success: true, data: { success: true, return_value: JSON.stringify(value), output: "", errors: [] } };
    },
  });
  return { mock, requested };
}

let encrypted = "";
beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  encrypted = await encryptSecret("pass");
});

function deps(mock: MockMcpClient) {
  return {
    sites: {
      async getSiteCredentials(id: string) {
        return id === "site-1"
          ? { mcp_endpoint: "https://x.example/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: encrypted }
          : null;
      },
    },
    mcp: async () => mock,
  } as unknown as Parameters<typeof gateOnBackup>[0];
}

describe("gateOnBackup (queued updates)", () => {
  it("lets the update run when the operator chose to skip the backup, without touching the site", async () => {
    const { mock } = site({ plugin: null, last: null, success: null, pending: false });
    await expect(gateOnBackup(deps(mock), "site-1", { backup: "skip" }, NOW)).resolves.toBeUndefined();
    expect(mock.calls).toHaveLength(0);
  });

  it("lets the update run on a fresh successful backup", async () => {
    const { mock, requested } = site({ plugin: "updraftplus", last: sec(NOW - 60_000), success: true, pending: false });
    await expect(gateOnBackup(deps(mock), "site-1", {}, NOW)).resolves.toBeUndefined();
    expect(requested).toHaveLength(0);
  });

  it("requests a backup and defers, recording when it asked", async () => {
    const { mock, requested } = site({ plugin: "updraftplus", last: sec(NOW - BACKUP_FRESH_MS - 1000), success: true, pending: false });
    const err = await gateOnBackup(deps(mock), "site-1", {}, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(DeferJob);
    expect(err.delayMs).toBe(BACKUP_POLL_MS);
    expect(err.payloadPatch).toEqual({ backup_requested_at: NOW });
    expect(requested).toHaveLength(1);
  });

  it("keeps waiting, without asking again, while the requested backup runs", async () => {
    const { mock, requested } = site({ plugin: "updraftplus", last: sec(NOW - 86_400_000), success: true, pending: true });
    const err = await gateOnBackup(deps(mock), "site-1", { backup_requested_at: NOW - 5 * 60_000 }, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(DeferJob);
    expect(err.payloadPatch).toEqual({ backup_requested_at: NOW - 5 * 60_000 });
    expect(requested).toHaveLength(0);
  });

  it("shares one backup across a bulk action's jobs: a sibling's request is adopted, not repeated", async () => {
    const { mock, requested } = site({ plugin: "updraftplus", last: sec(NOW - BACKUP_FRESH_MS - 1000), success: true, pending: false });
    const siblingAt = NOW - 90_000;
    const d = { ...deps(mock), siteBackupRequestedAt: async () => siblingAt };
    const err = await gateOnBackup(d, "site-1", {}, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(DeferJob);
    expect(err.payloadPatch).toEqual({ backup_requested_at: siblingAt });
    expect(requested).toHaveLength(0);
  });

  it("waits for an already-queued backup without asking again, and starts its own timeout", async () => {
    const { mock, requested } = site({ plugin: "updraftplus", last: sec(NOW - BACKUP_FRESH_MS - 1000), success: true, pending: true });
    const err = await gateOnBackup(deps(mock), "site-1", {}, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(DeferJob);
    expect(err.payloadPatch).toEqual({ backup_requested_at: NOW });
    expect(requested).toHaveLength(0);
  });

  it("refuses without retry when the site has no UpdraftPlus", async () => {
    const { mock } = site({ plugin: null, last: null, success: null, pending: false });
    const err = await gateOnBackup(deps(mock), "site-1", {}, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.message).toMatch(/without a backup/);
  });

  it("closes every connection it opens", async () => {
    const { mock } = site({ plugin: "updraftplus", last: sec(NOW - 60_000), success: true, pending: false });
    await gateOnBackup(deps(mock), "site-1", {}, NOW);
    expect(mock.closed).toBe(true);
  });
});

describe("backupReadyForInlineUpdate (core update button)", () => {
  it("is ready on a fresh backup", async () => {
    const { mock } = site({ plugin: "updraftplus", last: sec(NOW - 60_000), success: true, pending: false });
    expect(await backupReadyForInlineUpdate(deps(mock), "site-1", NOW)).toEqual({ ready: true });
  });

  it("is not ready, and never starts a backup itself, when the last one is stale", async () => {
    const { mock, requested } = site({ plugin: "updraftplus", last: sec(NOW - BACKUP_FRESH_MS - 1000), success: true, pending: false });
    const res = await backupReadyForInlineUpdate(deps(mock), "site-1", NOW);
    expect(res.ready).toBe(false);
    expect(requested).toHaveLength(0);
  });
});

describe("update handlers go through the backup gate", () => {
  it("bulk_manage updates and update_all_plugins call gateOnBackup; other kinds do not", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/services/jobs/handlers.ts", import.meta.url), "utf8");
    const bulk = src.slice(src.indexOf("bulk_manage: async"), src.indexOf("update_all_plugins: async"));
    const all = src.slice(src.indexOf("update_all_plugins: async"), src.indexOf("harden: async"));
    expect(bulk).toMatch(/if \(p\.kind === "update"\) \{\s*await gateOnBackup\(/);
    expect(all).toContain("await gateOnBackup(");
    // The gate runs after the authority check and before anything touches the site.
    expect(all.indexOf("assertActorAuthorized")).toBeLessThan(all.indexOf("gateOnBackup"));
    expect(all.indexOf("gateOnBackup")).toBeLessThan(all.indexOf("manageSite("));
  });
});
