import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolCtx } from "@/mcp/context";
import type { HeldJobNote } from "@/services/manage/held-jobs";
import { ctxFor } from "./helpers/mcp-ctx";

// update_all_plugins_fleet skips a site that already has an update run live.
// When that run is held for a maintenance window, the tool must say when it
// is scheduled and where to cancel it, not "pending from an earlier run".

async function connect(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  (await import("@/mcp/tools/fleet")).register(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
const isError = (r: unknown) => Boolean((r as { isError?: boolean }).isError);

const HELD: HeldJobNote = {
  siteName: "Acme Co", text: "already scheduled for Sat 3 Oct, 01:00 (Asia/Manila)",
  cancellable: true, batchId: "b-held",
};

function withPlan(ctx: ReturnType<typeof ctxFor>, eligible: unknown[]) {
  const seenDeps: Record<string, unknown>[] = [];
  (ctx as unknown as { planFleetPluginUpdate: unknown }).planFleetPluginUpdate = async (
    deps: Record<string, unknown>,
  ) => {
    seenDeps.push(deps);
    return { eligible, alreadyQueued: [{ id: "busy" }], noUpdates: [], heldNotes: [HELD] };
  };
  return seenDeps;
}

describe("update_all_plugins_fleet held-run message", () => {
  it("refuses with when the held run is scheduled and its batch page", async () => {
    const ctx = ctxFor();
    const seen = withPlan(ctx, []);
    const { client, close } = await connect(ctx);
    const res = await client.callTool({ name: "update_all_plugins_fleet", arguments: { environment: "staging" } });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("Acme Co already scheduled for Sat 3 Oct, 01:00 (Asia/Manila)");
    expect(textOf(res)).toContain("/marketplace/batches/b-held");
    expect(textOf(res)).not.toMatch(/earlier run/);
    expect(seen[0].held).toBe(ctx.heldJobs);
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("names the held site in the dry-run preview when others are eligible", async () => {
    const ctx = ctxFor();
    withPlan(ctx, [{ id: "s2", name: "Beta", url: "https://beta.example.com", status: "connected" }]);
    const { client, close } = await connect(ctx);
    const res = await client.callTool({ name: "update_all_plugins_fleet", arguments: { environment: "staging" } });
    expect(isError(res)).toBe(false);
    expect(textOf(res)).toContain("Acme Co already scheduled for Sat 3 Oct, 01:00 (Asia/Manila)");
    await close();
  });
});
