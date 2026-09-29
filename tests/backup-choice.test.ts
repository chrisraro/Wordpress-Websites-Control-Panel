import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { backupPayload, parseBackupChoice } from "@/services/backup/choice";
import { BackupChoice } from "@/components/ui/backup-choice";

// The "update without a backup" choice on every dialog that queues updates.
// Default is "back up first" -- the payload carries no `backup` field at all,
// which gateOnBackup reads as "required" -- and only the literal "skip"
// turns it off, so a tampered form value can never silently drop a backup.

function fd(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

describe("parseBackupChoice", () => {
  it("is required when the field is absent", () => {
    expect(parseBackupChoice(fd([]))).toBe("required");
    expect(parseBackupChoice(undefined)).toBe("required");
    expect(parseBackupChoice(null)).toBe("required");
  });

  it("is skip only for the literal value skip", () => {
    expect(parseBackupChoice(fd([["backup", "skip"]]))).toBe("skip");
    expect(parseBackupChoice(fd([["backup", "SKIP"]]))).toBe("required");
    expect(parseBackupChoice(fd([["backup", "on"]]))).toBe("required");
    expect(parseBackupChoice(fd([["backup", "required"]]))).toBe("required");
  });
});

describe("backupPayload", () => {
  it("adds nothing when a backup is required", () => {
    expect(backupPayload("required")).toEqual({});
    expect(backupPayload(undefined)).toEqual({});
  });

  it("marks the job skip when the operator chose no backup", () => {
    expect(backupPayload("skip")).toEqual({ backup: "skip" });
  });
});

describe("BackupChoice", () => {
  it("posts backup=skip from an unticked-by-default checkbox", () => {
    const html = renderToStaticMarkup(createElement(BackupChoice));
    expect(html).toMatch(/type="checkbox"/);
    expect(html).toMatch(/name="backup"/);
    expect(html).toMatch(/value="skip"/);
    expect(html).not.toMatch(/checked=""/);
    expect(html).toContain("Update without a backup");
  });

  it("explains what happens with and without UpdraftPlus", () => {
    const html = renderToStaticMarkup(createElement(BackupChoice));
    expect(html).toMatch(/UpdraftPlus/);
    expect(html).toMatch(/backed up first/i);
    expect(html).toMatch(/without it will fail/i);
  });

  it("reflects a controlled value", () => {
    const html = renderToStaticMarkup(BackupChoice({ skip: true, onChange: () => {} }));
    expect(html).toMatch(/checked=""/);
  });
});

// Source scans, house style (see tests/copy-button-secret.test.ts): this
// suite runs in node without a DOM harness, so the wiring of the choice into
// each dialog is pinned by reading the files.
const ROOT = join(__dirname, "..", "src");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

describe("every dialog that queues updates offers the choice", () => {
  it("the Plugins tab's bulk Update passes it to bulkAction", () => {
    const src = read("app", "(dashboard)", "sites", "[id]", "plugins", "plugin-table.tsx");
    expect(src).toContain("<BackupChoice");
    expect(src).toMatch(/bulkAction\([^)]*backup:/);
  });

  it("the Themes tab's bulk Update passes it to bulkAction", () => {
    const src = read("app", "(dashboard)", "sites", "[id]", "themes", "theme-table.tsx");
    expect(src).toContain("<BackupChoice");
    expect(src).toMatch(/bulkAction\([^)]*backup:/);
  });

  it("the dashboard's fleet plugin update opts into it", () => {
    const src = read("app", "(dashboard)", "dashboard", "page.tsx");
    const block = src.slice(src.indexOf("action={updateAllPluginsAction"));
    expect(block.slice(0, 400)).toContain("backupChoice");
  });

  it("ManageForm renders it inside the confirmation when asked", () => {
    const src = read("app", "(dashboard)", "sites", "[id]", "action-form.tsx");
    expect(src).toMatch(/backupChoice && <BackupChoice/);
  });
});
