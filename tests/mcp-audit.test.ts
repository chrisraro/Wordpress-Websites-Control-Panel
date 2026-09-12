import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolCtx } from "@/mcp/context";
import type { GeoGridConfig } from "@/services/geogrid/types";
import { ctxFor } from "./helpers/mcp-ctx";

const SITE_ID = "1b6e3d4f-5c7e-4a92-8d3b-6f4c2a9e7b51";
const CONFIG_ID = "2c7f4e5a-6d8f-4b03-9e4c-7a5d3b1f8c62";

const GEOGRID_CONFIG: GeoGridConfig = {
  id: CONFIG_ID,
  site_id: SITE_ID,
  business_name: "Alpha Co",
  place_ref: null,
  keywords: ["plumber", "electrician", "roofer"],
  grid_size: 5,
  spacing_m: 500,
  center_lat: 1,
  center_lng: 2,
  provider: "stub",
  created_at: "2026-09-01T00:00:00Z",
};

/**
 * The four enqueue tools whose job is exactly one enqueueJob({}, {dedupe:
 * true}) call, mirroring the brief's worked example for refresh_inventory.
 * run_geogrid is deliberately excluded: its handler requires
 * `{ config_id, keyword }` per job (src/services/jobs/handlers.ts:121-123),
 * so it enqueues one job per keyword sharing a batch id, not one job with an
 * empty payload -- see the "run_geogrid" describe block below.
 */
const SIMPLE_ENQUEUE_TOOLS = [
  { name: "refresh_inventory", permission: "sites.manage", jobType: "snapshot_refresh" },
  { name: "run_security_scan", permission: "security.run", jobType: "security_scan" },
  { name: "run_seo_scan", permission: "seo.run", jobType: "seo_scan" },
  { name: "generate_report", permission: "reports.generate", jobType: "report_generate" },
] as const;

/** Every enqueue tool, for the permission and read-only-token refusal checks,
 * which apply identically regardless of what a tool enqueues -- both guards
 * run before the tool ever looks at a GeoGrid config or report sections. */
const ALL_ENQUEUE_TOOLS = [
  ...SIMPLE_ENQUEUE_TOOLS,
  { name: "run_geogrid", permission: "geogrid.manage", jobType: "geogrid_run" },
] as const;

async function connectAll(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  for (const name of ["inventory", "security", "seo", "geogrid", "reports", "jobs"]) {
    const mod = await import(`@/mcp/tools/${name}`);
    mod.register(server, ctx);
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const isError = (r: unknown) => Boolean((r as { isError?: boolean }).isError);
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe.each(SIMPLE_ENQUEUE_TOOLS)("$name", (t) => {
  it(`enqueues ${t.jobType} and audits exactly one row`, async () => {
    const ctx = ctxFor({ permissions: [t.permission], grants: [[SITE_ID, "manage"]] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name: t.name, arguments: { site_id: SITE_ID } });

    expect(isError(res)).toBe(false);
    expect(ctx.enqueued).toHaveLength(1);
    expect(ctx.enqueued[0]).toMatchObject({ type: t.jobType, siteId: SITE_ID });
    expect(ctx.audited).toHaveLength(1);
    expect(ctx.audited[0].action).toBe(`mcp.${t.name}`);
    expect(ctx.audited[0].siteId).toBe(SITE_ID);
    await close();
  });
});

describe.each(ALL_ENQUEUE_TOOLS)("$name guards", (t) => {
  it(`refuses without the ${t.permission} permission, naming it`, async () => {
    const ctx = ctxFor({ permissions: [], grants: [[SITE_ID, "manage"]] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name: t.name, arguments: { site_id: SITE_ID } });

    expect(isError(res)).toBe(true);
    // A missing permission must name the permission: the fix is to be granted
    // it, which the caller cannot deduce from a generic refusal.
    expect(textOf(res)).toContain(t.permission);
    expect(ctx.enqueued).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });

  it("refuses on a read-only token, blaming the token", async () => {
    const ctx = ctxFor({
      permissions: [t.permission], grants: [[SITE_ID, "manage"]], readOnly: true,
    });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name: t.name, arguments: { site_id: SITE_ID } });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/read-only/i);
    expect(ctx.enqueued).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });
});

describe("audit detail", () => {
  it("carries the token id and never a secret-looking argument value", async () => {
    const ctx = ctxFor({ permissions: ["sites.manage"], grants: [[SITE_ID, "manage"]] });
    const { client, close } = await connectAll(ctx);
    await client.callTool({ name: "refresh_inventory", arguments: { site_id: SITE_ID } });
    const detail = JSON.stringify(ctx.audited[0].detail);
    expect(detail).toContain(SITE_ID);
    expect(detail).not.toMatch(/hunter2|wpcp_/);
    await close();
  });
});

describe("run_geogrid", () => {
  it("enqueues one geogrid_run job per keyword, all sharing one batch id", async () => {
    const ctx = ctxFor({ permissions: ["geogrid.manage"], grants: [[SITE_ID, "manage"]] });
    (ctx as unknown as { geogrid: { getConfigBySite: () => Promise<GeoGridConfig> } })
      .geogrid.getConfigBySite = async () => GEOGRID_CONFIG;
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name: "run_geogrid", arguments: { site_id: SITE_ID } });

    expect(isError(res)).toBe(false);
    expect(ctx.enqueued).toHaveLength(3);
    const batchIds = new Set(ctx.enqueued.map((j) => j.batchId));
    expect(batchIds.size).toBe(1);
    for (const job of ctx.enqueued) {
      expect(job.type).toBe("geogrid_run");
      expect(job.siteId).toBe(SITE_ID);
      expect(job.payload.config_id).toBe(CONFIG_ID);
    }
    expect(ctx.enqueued.map((j) => j.payload.keyword)).toEqual(["plumber", "electrician", "roofer"]);
    expect(ctx.audited).toHaveLength(1);
    expect(ctx.audited[0].action).toBe("mcp.run_geogrid");
    expect(ctx.audited[0].siteId).toBe(SITE_ID);
    expect(ctx.audited[0].detail.keywords).toBe(3);
    await close();
  });

  it("refuses clearly, enqueuing and auditing nothing, when the site has no GeoGrid configuration", async () => {
    const ctx = ctxFor({ permissions: ["geogrid.manage"], grants: [[SITE_ID, "manage"]] });
    // ctxFor's default geogrid.getConfigBySite already resolves to null.
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name: "run_geogrid", arguments: { site_id: SITE_ID } });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/geogrid/i);
    expect(ctx.enqueued).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });

  it("refuses clearly, enqueuing and auditing nothing, when the configuration has zero keywords", async () => {
    const ctx = ctxFor({ permissions: ["geogrid.manage"], grants: [[SITE_ID, "manage"]] });
    (ctx as unknown as { geogrid: { getConfigBySite: () => Promise<GeoGridConfig> } })
      .geogrid.getConfigBySite = async () => ({ ...GEOGRID_CONFIG, keywords: [] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name: "run_geogrid", arguments: { site_id: SITE_ID } });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/keyword/i);
    expect(ctx.enqueued).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });
});

describe("generate_report", () => {
  it("enqueues report_generate with the validated sections and period_days", async () => {
    const ctx = ctxFor({ permissions: ["reports.generate"], grants: [[SITE_ID, "manage"]] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "generate_report",
      arguments: { site_id: SITE_ID, sections: ["seo", "security"], period_days: 45 },
    });

    expect(isError(res)).toBe(false);
    expect(ctx.enqueued).toHaveLength(1);
    // parseSections preserves REPORT_SECTIONS's canonical order regardless
    // of the order arguments arrived in.
    expect(ctx.enqueued[0].payload).toEqual({ sections: ["security", "seo"], period_days: 45 });
    await close();
  });

  it("defaults to every section and a 30-day period when omitted", async () => {
    const ctx = ctxFor({ permissions: ["reports.generate"], grants: [[SITE_ID, "manage"]] });
    const { client, close } = await connectAll(ctx);
    await client.callTool({ name: "generate_report", arguments: { site_id: SITE_ID } });

    expect(ctx.enqueued[0].payload).toEqual({
      sections: ["security", "seo", "geogrid", "inventory"],
      period_days: 30,
    });
    await close();
  });

  it("refuses an out-of-vocabulary section", async () => {
    const ctx = ctxFor({ permissions: ["reports.generate"], grants: [[SITE_ID, "manage"]] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "generate_report",
      arguments: { site_id: SITE_ID, sections: ["not-a-real-section"] },
    });

    expect(isError(res)).toBe(true);
    expect(ctx.enqueued).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });
});
