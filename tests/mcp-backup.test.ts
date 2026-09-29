import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolCtx } from "@/mcp/context";
import { ctxFor } from "./helpers/mcp-ctx";

// skip_backup on the MCP tools that update: default false keeps the
// pre-update backup; true is the explicit "update without a backup". It is
// part of the confirm code's canonical arguments, so a dry run taken
// without it can never be replayed with it.

const REASON = "Applying the September security patch set";

async function connect(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  for (const name of ["manage", "fleet"]) {
    const mod = await import(`@/mcp/tools/${name}`);
    mod.register(server, ctx);
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
const isError = (r: unknown) => Boolean((r as { isError?: boolean }).isError);
const codeOf = (r: unknown) => /confirm_code: "([^"]+)"/.exec(textOf(r))?.[1];

/** Dry run with `args`, then the confirmed call with `args` + the code. */
async function dryThenConfirm(client: Client, name: string, args: Record<string, unknown>) {
  const dry = await client.callTool({ name, arguments: args });
  const code = codeOf(dry);
  expect(code).toBeTruthy();
  return client.callTool({ name, arguments: { ...args, confirm: true, reason: REASON, confirm_code: code } });
}

describe("update_all_plugins_fleet skip_backup", () => {
  function recordingCtx() {
    const ctx = ctxFor();
    const payloads: Record<string, unknown>[] = [];
    (ctx as unknown as { enqueueBatch: unknown }).enqueueBatch = async (
      _repo: unknown, _type: string, _ids: string[], payload: Record<string, unknown>,
    ) => {
      ctx.serviceCalls.push("enqueueBatch");
      payloads.push(payload);
      return { batchId: "b1", count: 1 };
    };
    return { ctx, payloads };
  }

  it("sends no backup field by default -- each site is backed up first", async () => {
    const { ctx, payloads } = recordingCtx();
    const { client, close } = await connect(ctx);
    const res = await dryThenConfirm(client, "update_all_plugins_fleet", { environment: "staging" });
    expect(isError(res)).toBe(false);
    expect(payloads).toEqual([{ actor: "u1" }]);
    await close();
  });

  it("sends backup: skip with skip_backup: true, and audits it", async () => {
    const { ctx, payloads } = recordingCtx();
    const { client, close } = await connect(ctx);
    const res = await dryThenConfirm(client, "update_all_plugins_fleet", { environment: "staging", skip_backup: true });
    expect(isError(res)).toBe(false);
    expect(payloads).toEqual([{ actor: "u1", backup: "skip" }]);
    expect(ctx.audited[0].detail.args).toMatchObject({ skip_backup: true });
    await close();
  });

  it("says in the dry run whether sites will be backed up", async () => {
    const { ctx } = recordingCtx();
    const { client, close } = await connect(ctx);
    const withBackup = await client.callTool({ name: "update_all_plugins_fleet", arguments: { environment: "staging" } });
    expect(textOf(withBackup)).toMatch(/backed up .*UpdraftPlus/i);
    const without = await client.callTool({
      name: "update_all_plugins_fleet", arguments: { environment: "staging", skip_backup: true },
    });
    expect(textOf(without)).toMatch(/without a backup/i);
    await close();
  });

  it("refuses to replay a dry run taken without skip_backup as one with it", async () => {
    const { ctx } = recordingCtx();
    const { client, close } = await connect(ctx);
    const dry = await client.callTool({ name: "update_all_plugins_fleet", arguments: { environment: "staging" } });
    const res = await client.callTool({
      name: "update_all_plugins_fleet",
      arguments: { environment: "staging", skip_backup: true, confirm: true, reason: REASON, confirm_code: codeOf(dry) },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/does not match/i);
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("documents the argument in the tool description and schema", async () => {
    const { ctx } = recordingCtx();
    const { client, close } = await connect(ctx);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "update_all_plugins_fleet")!;
    expect(tool.description).toMatch(/skip_backup/);
    expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("skip_backup");
    await close();
  });
});

describe("update_core backup check", () => {
  const SITE_ID = "1b6e3d4f-5c7e-4a92-8d3b-6f4c2a9e7b51";
  type Ready = { ready: true } | { ready: false; reason: string };

  function stubBackup(ctx: ReturnType<typeof ctxFor>, answer: () => Ready | Promise<Ready>) {
    const checks: string[] = [];
    (ctx as unknown as { backupReadyForInlineUpdate: unknown }).backupReadyForInlineUpdate = async (
      _deps: unknown, siteId: string,
    ) => {
      checks.push(siteId);
      return answer();
    };
    return checks;
  }

  it("updates when a fresh backup exists", async () => {
    const ctx = ctxFor();
    const checks = stubBackup(ctx, () => ({ ready: true }));
    const { client, close } = await connect(ctx);
    const res = await dryThenConfirm(client, "update_core", { site_id: SITE_ID });
    expect(isError(res)).toBe(false);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((id) => id === SITE_ID)).toBe(true);
    expect(ctx.serviceCalls).toEqual(["manageSite"]);
    await close();
  });

  it("refuses with the gate's reason, before any dry-run code, when there is no fresh backup", async () => {
    const ctx = ctxFor();
    stubBackup(ctx, () => ({ ready: false, reason: "No successful backup in the last 6 hours." }));
    const { client, close } = await connect(ctx);
    const dry = await client.callTool({ name: "update_core", arguments: { site_id: SITE_ID } });
    expect(isError(dry)).toBe(true);
    expect(textOf(dry)).toContain("No successful backup in the last 6 hours.");
    expect(textOf(dry)).toMatch(/skip_backup/);
    expect(codeOf(dry)).toBeUndefined();
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("refuses a confirmed call too when the backup went missing after the dry run", async () => {
    let ready = true;
    const ctx = ctxFor();
    stubBackup(ctx, () => (ready ? { ready: true } : { ready: false, reason: "The last backup failed." }));
    const { client, close } = await connect(ctx);
    const dry = await client.callTool({ name: "update_core", arguments: { site_id: SITE_ID } });
    ready = false;
    const res = await client.callTool({
      name: "update_core",
      arguments: { site_id: SITE_ID, confirm: true, reason: REASON, confirm_code: codeOf(dry) },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("The last backup failed.");
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("with skip_backup: true, never checks and updates anyway", async () => {
    const ctx = ctxFor();
    const checks = stubBackup(ctx, () => ({ ready: false, reason: "No backup plugin" }));
    const { client, close } = await connect(ctx);
    const res = await dryThenConfirm(client, "update_core", { site_id: SITE_ID, skip_backup: true });
    expect(isError(res)).toBe(false);
    expect(checks).toEqual([]);
    expect(ctx.serviceCalls).toEqual(["manageSite"]);
    expect(ctx.audited[0].detail.args).toMatchObject({ skip_backup: true });
    await close();
  });

  it("cannot replay a backed-up dry run as a skip_backup call", async () => {
    const ctx = ctxFor();
    stubBackup(ctx, () => ({ ready: true }));
    const { client, close } = await connect(ctx);
    const dry = await client.callTool({ name: "update_core", arguments: { site_id: SITE_ID } });
    const res = await client.callTool({
      name: "update_core",
      arguments: { site_id: SITE_ID, skip_backup: true, confirm: true, reason: REASON, confirm_code: codeOf(dry) },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/does not match/i);
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("reports an unreachable site as a failure, not a crash", async () => {
    const ctx = ctxFor();
    stubBackup(ctx, () => { throw new Error("fetch failed"); });
    const { client, close } = await connect(ctx);
    const res = await client.callTool({ name: "update_core", arguments: { site_id: SITE_ID } });
    expect(isError(res)).toBe(true);
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("checks nothing for a caller without access to the site", async () => {
    const ctx = ctxFor({ grants: [], permissions: ["wp_toolkit.manage"] });
    const checks = stubBackup(ctx, () => ({ ready: true }));
    const { client, close } = await connect(ctx);
    const res = await client.callTool({ name: "update_core", arguments: { site_id: SITE_ID } });
    expect(textOf(res)).toMatch(/not found/i);
    expect(checks).toEqual([]);
    await close();
  });

  it("documents skip_backup on update_core", async () => {
    const ctx = ctxFor();
    const { client, close } = await connect(ctx);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "update_core")!;
    expect(tool.description).toMatch(/skip_backup/);
    expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("skip_backup");
    await close();
  });
});

// Plugin and theme updates over MCP run inline too, so they get the same
// check as update_core: on the dry run and again when confirmed, skippable
// only with skip_backup: true, which is bound into the confirm code.
describe.each([
  ["update_plugins", { plugin_file: "akismet/akismet.php" }, "update_plugin"],
  ["update_plugins", {}, "update_all_plugins"],
  ["update_themes", { slug: "twentytwentyfour" }, "update_theme"],
] as const)("%s backup check (%j -> %s)", (tool, extra, kind) => {
  const SITE_ID = "1b6e3d4f-5c7e-4a92-8d3b-6f4c2a9e7b51";
  type Ready = { ready: true } | { ready: false; reason: string };
  const base = () => ({ site_id: SITE_ID, ...extra });

  function stubBackup(ctx: ReturnType<typeof ctxFor>, answer: () => Ready | Promise<Ready>) {
    const checks: string[] = [];
    (ctx as unknown as { backupReadyForInlineUpdate: unknown }).backupReadyForInlineUpdate = async (
      _deps: unknown, siteId: string,
    ) => {
      checks.push(siteId);
      return answer();
    };
    return checks;
  }

  function recordActions(ctx: ReturnType<typeof ctxFor>) {
    const actions: { kind: string }[] = [];
    (ctx as unknown as { manageSite: unknown }).manageSite = async (
      _deps: unknown, _siteId: string, _actor: string, action: { kind: string },
    ) => {
      ctx.serviceCalls.push("manageSite");
      actions.push(action);
      return { ok: true, output: "Updated" };
    };
    return actions;
  }

  it("updates when a fresh backup exists, checking on dry run and confirm", async () => {
    const ctx = ctxFor();
    const checks = stubBackup(ctx, () => ({ ready: true }));
    const actions = recordActions(ctx);
    const { client, close } = await connect(ctx);
    const res = await dryThenConfirm(client, tool, base());
    expect(isError(res)).toBe(false);
    expect(checks).toEqual([SITE_ID, SITE_ID]);
    expect(actions.map((a) => a.kind)).toEqual([kind]);
    await close();
  });

  it("refuses the dry run with the gate's reason and hands out no code", async () => {
    const ctx = ctxFor();
    stubBackup(ctx, () => ({ ready: false, reason: "No successful backup in the last 6 hours." }));
    const { client, close } = await connect(ctx);
    const dry = await client.callTool({ name: tool, arguments: base() });
    expect(isError(dry)).toBe(true);
    expect(textOf(dry)).toContain("No successful backup in the last 6 hours.");
    expect(textOf(dry)).toMatch(/skip_backup: true/);
    expect(codeOf(dry)).toBeUndefined();
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("refuses the confirmed call when the backup went missing after the dry run", async () => {
    let ready = true;
    const ctx = ctxFor();
    stubBackup(ctx, () => (ready ? { ready: true } : { ready: false, reason: "The last backup failed." }));
    const { client, close } = await connect(ctx);
    const dry = await client.callTool({ name: tool, arguments: base() });
    ready = false;
    const res = await client.callTool({
      name: tool, arguments: { ...base(), confirm: true, reason: REASON, confirm_code: codeOf(dry) },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("The last backup failed.");
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("with skip_backup: true, never checks, says so in the preview, and audits it", async () => {
    const ctx = ctxFor();
    const checks = stubBackup(ctx, () => ({ ready: false, reason: "No backup plugin" }));
    const { client, close } = await connect(ctx);
    const dry = await client.callTool({ name: tool, arguments: { ...base(), skip_backup: true } });
    expect(textOf(dry)).toMatch(/WITHOUT a backup/);
    const res = await dryThenConfirm(client, tool, { ...base(), skip_backup: true });
    expect(isError(res)).toBe(false);
    expect(checks).toEqual([]);
    expect(ctx.serviceCalls).toEqual(["manageSite"]);
    expect(ctx.audited[0].detail.args).toMatchObject({ skip_backup: true });
    await close();
  });

  it("cannot replay a backed-up dry run as a skip_backup call", async () => {
    const ctx = ctxFor();
    stubBackup(ctx, () => ({ ready: true }));
    const { client, close } = await connect(ctx);
    const dry = await client.callTool({ name: tool, arguments: base() });
    const res = await client.callTool({
      name: tool,
      arguments: { ...base(), skip_backup: true, confirm: true, reason: REASON, confirm_code: codeOf(dry) },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/does not match/i);
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("reports an unreachable site as a failure, not a crash", async () => {
    const ctx = ctxFor();
    stubBackup(ctx, () => { throw new Error("fetch failed"); });
    const { client, close } = await connect(ctx);
    const res = await client.callTool({ name: tool, arguments: base() });
    expect(isError(res)).toBe(true);
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("checks nothing for a caller without access to the site", async () => {
    const ctx = ctxFor({ grants: [], permissions: ["wp_toolkit.manage"] });
    const checks = stubBackup(ctx, () => ({ ready: true }));
    const { client, close } = await connect(ctx);
    const res = await client.callTool({ name: tool, arguments: base() });
    expect(textOf(res)).toMatch(/not found/i);
    expect(checks).toEqual([]);
    await close();
  });

  it("documents skip_backup", async () => {
    const ctx = ctxFor();
    const { client, close } = await connect(ctx);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === tool)!;
    expect(t.description).toMatch(/skip_backup/);
    expect(t.description).toMatch(/UpdraftPlus/);
    expect(Object.keys(t.inputSchema.properties ?? {})).toContain("skip_backup");
    await close();
  });
});
