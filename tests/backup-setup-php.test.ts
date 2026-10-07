import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETUP_UPDRAFT_PHP } from "@/services/backup/setup";

// Runs the real setup PHP against a stub WordPress (tests/fixtures/wp-stub.php)
// so the schedule and Drive rules are checked by behaviour, not by grepping
// the source. Skipped where no PHP CLI is installed.
const hasPhp = spawnSync("php", ["-v"]).status === 0;
const NOW = Date.parse("2026-10-07T03:00:00Z") / 1000;
const DAY = 86400;
const PLUGIN = "updraftplus/updraftplus.php";

type Run = { result: Record<string, unknown>; options: Record<string, unknown>; cron: Record<string, { ts: number; rec: string }> };

function run(options: Record<string, unknown>): Run {
  const dir = mkdtempSync(join(tmpdir(), "wpstub-"));
  const scenario = join(dir, "s.json");
  const code = join(dir, "code.php");
  writeFileSync(scenario, JSON.stringify({ now: NOW, plugins: { [PLUGIN]: {} }, active: [PLUGIN], options }));
  writeFileSync(code, SETUP_UPDRAFT_PHP);
  const out = execFileSync("php", [join(__dirname, "fixtures", "wp-stub.php"), scenario, code], { encoding: "utf8" });
  return JSON.parse(out) as Run;
}

const drive = (cfg: Record<string, unknown>) => ({ version: "1", settings: { "s-1": { folder: "UpdraftPlus", instance_enabled: 1, ...cfg } } });

describe.skipIf(!hasPhp)("SETUP_UPDRAFT_PHP schedule rules (run in PHP)", () => {
  it.each(["every4hours", "twicedaily", "daily", "weekly", "manual"])(
    "turns %s into every two weeks for files and database", (interval) => {
      const r = run({ updraft_interval: interval, updraft_interval_database: interval, updraft_service: ["googledrive"] });
      expect(r.options.updraft_interval).toBe("fortnightly");
      expect(r.options.updraft_interval_database).toBe("fortnightly");
      expect(r.cron.updraft_backup.rec).toBe("fortnightly");
      expect(r.cron.updraft_backup_database.rec).toBe("fortnightly");
    });

  it("leaves monthly alone: it is already at least two weeks apart", () => {
    const r = run({ updraft_interval: "monthly", updraft_interval_database: "fortnightly" });
    expect(r.options.updraft_interval).toBe("monthly");
    expect(r.cron.updraft_backup.rec).toBe("monthly");
    expect((r.result.changed as string[]).join(" ")).not.toMatch(/Files/);
  });

  it("starts the cycle two weeks after the last backup, not immediately", () => {
    const last = NOW - 2 * DAY;
    const r = run({ updraft_interval: "weekly", updraft_last_backup: { backup_time: last } });
    expect(r.cron.updraft_backup.ts).toBe(last + 14 * DAY);
    expect(r.cron.updraft_backup_database.ts).toBeGreaterThan(r.cron.updraft_backup.ts);
  });

  it("starts within the hour when the site has never backed up, or is overdue", () => {
    expect(run({}).cron.updraft_backup.ts).toBe(NOW + 3600);
    expect(run({ updraft_last_backup: { backup_time: NOW - 40 * DAY } }).cron.updraft_backup.ts).toBe(NOW + 3600);
  });

  it("sees Drive as authorized through UpdraftPlus's relay (user_id), not only a stored token", () => {
    expect(run({ updraft_googledrive: drive({ user_id: "abc123" }) }).result.drive_authorized).toBe(true);
    expect(run({ updraft_googledrive: drive({ token: "x" }) }).result.drive_authorized).toBe(true);
    expect(run({ updraft_googledrive: drive({}) }).result.drive_authorized).toBe(false);
  });

  it("never rewrites existing Drive settings or removes another destination", () => {
    const existing = drive({ user_id: "abc123", tmp_access_token: "t" });
    const r = run({ updraft_googledrive: existing, updraft_service: ["s3"] });
    expect(r.options.updraft_googledrive).toEqual(existing);
    expect(r.options.updraft_service).toEqual(["s3", "googledrive"]);
  });
});
