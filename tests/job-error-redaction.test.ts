import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

// Security finding: jobs.last_error is raw worker output -- PHP fatals,
// upstream HTTP bodies, file paths on the managed host -- and it was
// returned verbatim to any viewer who could see the job's site, including
// `client` accounts. Only staff (sites.view_all) get the raw text and the
// attempt count; everyone else gets a generic message.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolCtx } from "@/mcp/context";
import type { JobRow } from "@/services/jobs/types";
import { ctxFor, SITE_ID, BATCH_ID } from "./helpers/mcp-ctx";
import { GENERIC_JOB_ERROR, jobErrorFor } from "@/lib/authz/job-detail";
import type { Viewer } from "@/lib/authz/decide";

const RAW = "PHP Fatal error: require(/home/acme/public_html/wp-config.php): failed";

const getViewerMock = vi.fn();
vi.mock("@/lib/authz/server", () => ({
  getViewer: (...a: unknown[]) => getViewerMock(...a),
}));

let geogridRows: unknown[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createServiceSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: geogridRows, error: null }) }) }) }),
      }),
    }),
  }),
}));

let batchRows: JobRow[] = [];
vi.mock("@/services/jobs/repo", () => ({
  supabaseJobsRepo: () => ({ batchJobs: async () => batchRows }),
}));
vi.mock("@/services/sites/repo", () => ({
  supabaseSitesRepo: () => ({ listSites: async () => [{ id: SITE_ID, name: "Alpha" }] }),
}));

import { GET as batchGET } from "@/app/api/batches/[id]/route";
import { GET as geogridGET } from "@/app/api/sites/[id]/geogrid-runs/route";

function failedJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1", type: "plugin_install", site_id: SITE_ID, batch_id: BATCH_ID,
    payload: { label: "akismet", keyword: "plumber" }, status: "failed", attempts: 3,
    scheduled_for: "2026-09-01T00:00:00Z", last_error: RAW,
    cancelled_at: null, dismissed_at: null, finished_at: "2026-09-01T00:05:00Z",
    ...overrides,
  } as JobRow;
}

function viewer(perms: string[], grants: [string, "read" | "manage"][]): Viewer {
  return {
    id: "u1", email: null, role: perms.length ? "admin" : "client",
    permissions: new Set(perms) as Viewer["permissions"], grants: new Map(grants),
  };
}
const STAFF = viewer(["sites.view_all"], []);
const CLIENT = viewer([], [[SITE_ID, "read"]]);

const ctxArg = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  getViewerMock.mockReset();
  batchRows = [failedJob()];
  geogridRows = [{ id: "run-1", status: "failed", payload: { keyword: "plumber" }, last_error: RAW }];
});

describe("jobErrorFor", () => {
  it("gives staff the raw error", () => {
    expect(jobErrorFor(STAFF, RAW)).toBe(RAW);
  });
  it("gives everyone else a generic message", () => {
    expect(jobErrorFor(CLIENT, RAW)).toBe(GENERIC_JOB_ERROR);
  });
  it("keeps null as null", () => {
    expect(jobErrorFor(CLIENT, null)).toBeNull();
  });
});

describe("GET /api/batches/[id]", () => {
  it("hides last_error and attempts from a non-staff viewer", async () => {
    getViewerMock.mockResolvedValue(CLIENT);
    const res = await batchGET(new Request("https://panel.test"), ctxArg(BATCH_ID));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("wp-config");
    expect(body.jobs[0].last_error).toBe(GENERIC_JOB_ERROR);
    expect(body.jobs[0]).not.toHaveProperty("attempts");
  });

  it("still gives staff the raw error and attempts", async () => {
    getViewerMock.mockResolvedValue(STAFF);
    const res = await batchGET(new Request("https://panel.test"), ctxArg(BATCH_ID));
    const body = await res.json();
    expect(body.jobs[0].last_error).toBe(RAW);
    expect(body.jobs[0].attempts).toBe(3);
  });
});

describe("GET /api/sites/[id]/geogrid-runs", () => {
  it("hides last_error from a non-staff viewer", async () => {
    getViewerMock.mockResolvedValue(CLIENT);
    const res = await geogridGET(new Request("https://panel.test"), ctxArg(SITE_ID));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("wp-config");
    expect(body.jobs[0].last_error).toBe(GENERIC_JOB_ERROR);
  });

  it("still gives staff the raw error", async () => {
    getViewerMock.mockResolvedValue(STAFF);
    const res = await geogridGET(new Request("https://panel.test"), ctxArg(SITE_ID));
    expect((await res.json()).jobs[0].last_error).toBe(RAW);
  });
});

async function connectJobs(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  (await import("@/mcp/tools/jobs")).register(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

function mcpCtx(perms: Parameters<typeof ctxFor>[0]) {
  const ctx = ctxFor(perms);
  const jr = (ctx as unknown as { jobsRead: { listJobs: unknown; batchJobs: unknown } }).jobsRead;
  jr.listJobs = async () => [failedJob()];
  jr.batchJobs = async () => [failedJob()];
  return ctx as unknown as ToolCtx;
}

describe("MCP list_jobs / get_batch", () => {
  for (const tool of ["list_jobs", "get_batch"] as const) {
    const args = tool === "get_batch" ? { batch_id: BATCH_ID } : {};

    it(`${tool} hides last_error and attempts from a non-staff token`, async () => {
      const { client, close } = await connectJobs(mcpCtx({ permissions: [], grants: [[SITE_ID, "read"]] }));
      const res = await client.callTool({ name: tool, arguments: args });
      const text = textOf(res);
      expect(text).not.toContain("wp-config");
      const out = JSON.parse(text);
      expect(out.jobs[0].last_error).toBe(GENERIC_JOB_ERROR);
      expect(out.jobs[0]).not.toHaveProperty("attempts");
      await close();
    });

    it(`${tool} still gives staff the raw error`, async () => {
      const { client, close } = await connectJobs(mcpCtx({ permissions: ["sites.view_all"] }));
      const res = await client.callTool({ name: tool, arguments: args });
      const out = JSON.parse(textOf(res));
      expect(out.jobs[0].last_error).toBe(RAW);
      expect(out.jobs[0].attempts).toBe(3);
      await close();
    });
  }
});
