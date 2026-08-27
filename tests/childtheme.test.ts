import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { buildChildThemePhp, createChildTheme } from "@/services/childtheme/service";
import type { ChildThemeDeps } from "@/services/childtheme/service";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("buildChildThemePhp", () => {
  it("guards against child-of-child and existing directories, writes both files", () => {
    const code = buildChildThemePhp(false);
    expect(code).toContain("get_template()");
    expect(code).toContain("get_stylesheet()");
    expect(code).toContain("already a child theme");
    expect(code).toContain("file_exists($dir)");
    expect(code).toContain("style.css");
    expect(code).toContain("functions.php");
    expect(code).toContain("Template: ");
    expect(code).toContain("return json_encode");
    expect(code).not.toContain("switch_theme");
  });
  it("activates via switch_theme when requested", () => {
    expect(buildChildThemePhp(true)).toContain("switch_theme");
  });
});

function phpResult(payload: unknown) {
  return { success: true, data: { success: true, return_value: JSON.stringify(payload), output: "", errors: [] } };
}

function fakeDeps(mock: MockMcpClient) {
  const activity: Array<Record<string, unknown>> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  let creds = "";
  const sites = {
    async getSiteCredentials(id: string) {
      return id === "site-1"
        ? { mcp_endpoint: "https://x/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: creds }
        : null;
    },
    async insertActivity(e: Record<string, unknown>) { activity.push(e); },
  } as unknown as SitesRepo;
  const jobs = {
    async pendingExists() { return false; },
    async insert(j: Record<string, unknown>) { enqueued.push(j); return { id: "j1" }; },
  } as unknown as JobsRepo;
  const deps: ChildThemeDeps = { sites, jobs, mcp: async () => mock };
  return { deps, activity, enqueued, setCreds: (v: string) => { creds = v; } };
}

describe("createChildTheme", () => {
  it("creates, logs, and enqueues snapshot refresh", async () => {
    const mock = new MockMcpClient({
      handler: () => phpResult({ ok: true, message: "Child theme generatepress-child created" }),
    });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await createChildTheme(f.deps, "site-1", "user-1", true);
    expect(res.ok).toBe(true);
    expect(mock.closed).toBe(true);
    expect(f.activity[0]).toMatchObject({ actor: "user-1", action: "site.child_theme" });
    expect(f.enqueued[0]).toMatchObject({ type: "snapshot_refresh" });
  });
  it("surfaces guard failures without refresh", async () => {
    const mock = new MockMcpClient({
      handler: () => phpResult({ ok: false, error: "Active theme is already a child theme (gp-child)" }),
    });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await createChildTheme(f.deps, "site-1", "user-1", false);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("already a child") });
    expect(f.enqueued).toHaveLength(0);
  });
});
