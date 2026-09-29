import { describe, expect, it } from "vitest";
import {
  BACKUP_FRESH_MS, BACKUP_TIMEOUT_MS, REQUEST_BACKUP_PHP, BACKUP_STATUS_PHP, decideBackup,
} from "@/services/backup/updraft";

const NOW = Date.parse("2026-09-29T04:00:00Z");
const sec = (ms: number) => Math.floor(ms / 1000);

describe("decideBackup", () => {
  it("proceeds when the caller explicitly skipped the backup", () => {
    expect(decideBackup({ policy: "skip", status: null, now: NOW })).toEqual({ kind: "proceed" });
  });

  it("fails without retry when no supported backup plugin is active", () => {
    const d = decideBackup({ policy: "required", status: { plugin: null, last_backup_time: null, success: null, pending: false }, now: NOW });
    expect(d.kind).toBe("fail");
    if (d.kind === "fail") expect(d.reason).toMatch(/UpdraftPlus/);
  });

  it("proceeds when a successful backup is fresh enough", () => {
    const status = { plugin: "updraftplus" as const, last_backup_time: sec(NOW - BACKUP_FRESH_MS + 60_000), success: true, pending: false };
    expect(decideBackup({ policy: "required", status, now: NOW })).toEqual({ kind: "proceed" });
  });

  it("requests a backup when the last one is stale and none was requested", () => {
    const status = { plugin: "updraftplus" as const, last_backup_time: sec(NOW - BACKUP_FRESH_MS - 60_000), success: true, pending: false };
    expect(decideBackup({ policy: "required", status, now: NOW }).kind).toBe("request");
  });

  it("does not accept a failed last backup as fresh", () => {
    const status = { plugin: "updraftplus" as const, last_backup_time: sec(NOW - 60_000), success: false, pending: false };
    expect(decideBackup({ policy: "required", status, now: NOW }).kind).toBe("request");
  });

  it("proceeds once a backup finished after it was requested", () => {
    const requestedAt = NOW - 10 * 60_000;
    const status = { plugin: "updraftplus" as const, last_backup_time: sec(requestedAt + 5 * 60_000), success: true, pending: false };
    expect(decideBackup({ policy: "required", status, now: NOW, requestedAt })).toEqual({ kind: "proceed" });
  });

  it("waits while a requested backup has not finished", () => {
    const requestedAt = NOW - 10 * 60_000;
    const status = { plugin: "updraftplus" as const, last_backup_time: sec(requestedAt - 86_400_000), success: true, pending: true };
    expect(decideBackup({ policy: "required", status, now: NOW, requestedAt }).kind).toBe("wait");
  });

  it("fails once a requested backup is overdue", () => {
    const requestedAt = NOW - BACKUP_TIMEOUT_MS - 1;
    const status = { plugin: "updraftplus" as const, last_backup_time: null, success: null, pending: false };
    const d = decideBackup({ policy: "required", status, now: NOW, requestedAt });
    expect(d.kind).toBe("fail");
    if (d.kind === "fail") expect(d.reason).toMatch(/did not finish/);
  });

  it("fails when a requested backup finished with errors", () => {
    const requestedAt = NOW - 10 * 60_000;
    const status = { plugin: "updraftplus" as const, last_backup_time: sec(requestedAt + 60_000), success: false, pending: false };
    const d = decideBackup({ policy: "required", status, now: NOW, requestedAt });
    expect(d.kind).toBe("fail");
  });
});

describe("UpdraftPlus PHP", () => {
  it("requests the documented full backup action via WP-Cron, without blocking", () => {
    expect(REQUEST_BACKUP_PHP).toContain("wp_schedule_single_event");
    expect(REQUEST_BACKUP_PHP).toContain("'updraft_backupnow_backup_all'");
    expect(REQUEST_BACKUP_PHP).toContain("spawn_cron");
    expect(REQUEST_BACKUP_PHP).not.toMatch(/do_action\(\s*'updraft_backupnow_backup_all'/);
  });

  it("reads status from updraft_last_backup and detects a queued run", () => {
    expect(BACKUP_STATUS_PHP).toContain("get_option('updraft_last_backup')");
    expect(BACKUP_STATUS_PHP).toContain("'updraft_backupnow_backup_all'");
    expect(BACKUP_STATUS_PHP).toContain("class_exists('UpdraftPlus')");
  });
});

describe("inventory reports backup status", () => {
  it("collects UpdraftPlus's last run alongside the inventory", async () => {
    const { INVENTORY_PHP } = await import("@/services/inventory/service");
    expect(INVENTORY_PHP).toContain("class_exists('UpdraftPlus')");
    expect(INVENTORY_PHP).toContain("'backup' => $backup");
  });
});
