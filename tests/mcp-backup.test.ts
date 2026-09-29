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
