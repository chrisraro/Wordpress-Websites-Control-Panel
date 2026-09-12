import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DESTRUCTIVE_TOOLS } from "@/mcp/tools/manage";
import { NOT_FOUND } from "@/mcp/tools/sites";
import { installVerificationFile } from "@/services/gsc/service";
import type { ToolCtx } from "@/mcp/context";
import { APP_PERMISSIONS } from "@/lib/authz/types";
import { ctxFor, SITE_ID, BATCH_ID } from "./helpers/mcp-ctx";

/** Every permission except sites.view_all, which would bypass the grants
 * check entirely and make ctxFor({ grants: [] }) a no-op for canAccessSite. */
const PERMISSIONS_WITHOUT_VIEW_ALL = APP_PERMISSIONS.filter((p) => p !== "sites.view_all");

const REASON = "Applying the September security patch set";

/** Minimal valid arguments per tool, beyond confirm/reason. */
const ARGS: Record<string, Record<string, unknown>> = {
  update_plugins: { site_id: SITE_ID },
  update_themes: { site_id: SITE_ID, slugs: ["twentytwentyfour"] },
  update_core: { site_id: SITE_ID },
  activate_plugin: { site_id: SITE_ID, plugin_file: "akismet/akismet.php" },
  deactivate_plugin: { site_id: SITE_ID, plugin_file: "akismet/akismet.php" },
  delete_plugin: { site_id: SITE_ID, plugin_file: "akismet/akismet.php" },
  activate_theme: { site_id: SITE_ID, slug: "twentytwentyfour" },
  delete_theme: { site_id: SITE_ID, slug: "twentytwentyfour" },
  set_maintenance: { site_id: SITE_ID, enable: true },
  flush_cache: { site_id: SITE_ID },
  flush_permalinks: { site_id: SITE_ID },
  update_all_plugins_fleet: { environment: "staging" },
  cancel_batch: { batch_id: BATCH_ID },
  install_gsc_verification: { site_id: SITE_ID, file_name: "google1234abcd5678.html" },
  remove_gsc_verification: { site_id: SITE_ID, file_name: "google1234abcd5678.html" },
};

/**
 * How to make each tool's one write action report a failure, for the shared
 * "audits a failed live action" test below. `manage.ts`'s eleven single-site
 * tools all share the same seam (`ctx.manageSite`, returning `{ ok: false,
 * error }`); Task 10b's four tools each call a different seam whose natural
 * failure mode is a thrown error, not an `ok: false` return, so each entry
 * here throws instead. Every tool's handler is expected to turn either shape
 * into the same observable outcome: an error result carrying the message,
 * with exactly one audit row recording `ok: false`.
 */
const FAIL_SEAM: Partial<Record<string, (ctx: ReturnType<typeof ctxFor>) => void>> = {
  update_all_plugins_fleet: (ctx) => {
    (ctx as unknown as { enqueueBatch: () => Promise<never> }).enqueueBatch = async () => {
      ctx.serviceCalls.push("enqueueBatch");
      throw new Error("the site refused");
    };
  },
  cancel_batch: (ctx) => {
    (ctx as unknown as { jobs: { cancelBatch: () => Promise<never> } }).jobs.cancelBatch = async () => {
      ctx.serviceCalls.push("cancelBatch");
      throw new Error("the site refused");
    };
  },
  install_gsc_verification: (ctx) => {
    (ctx as unknown as { gsc: { install: () => Promise<never> } }).gsc.install = async () => {
      ctx.serviceCalls.push("gscInstall");
      throw new Error("the site refused");
    };
  },
  remove_gsc_verification: (ctx) => {
    (ctx as unknown as { gsc: { remove: () => Promise<never> } }).gsc.remove = async () => {
      ctx.serviceCalls.push("gscRemove");
      throw new Error("the site refused");
    };
  },
};

/**
 * The refusal message an ungranted caller sees before any confirm gate, for
 * the shared guard-order test below. Every `manage.ts`/`gsc.ts` tool refuses
 * with the site-level `NOT_FOUND` via `loadSite`, and `cancel_batch` refuses
 * with the equally-shaped `BATCH_NOT_FOUND` -- both match `/not found/i`.
 * `update_all_plugins_fleet` has no single site to gate on: its access
 * control lives entirely inside `planFleetPluginUpdate` (grant-aware even as
 * a test stub -- see tests/helpers/mcp-ctx.ts), and an ungranted caller sees
 * "nothing eligible" rather than a not-found refusal.
 */
const UNGRANTED_REFUSAL: Partial<Record<string, RegExp>> = {
  update_all_plugins_fleet: /no .* site .* plugin update|nothing eligible/i,
};

async function connectAll(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  for (const name of ["manage", "fleet", "gsc", "jobs"]) {
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

describe("coverage", () => {
  it("ARGS names exactly the declared destructive tools", () => {
    expect(Object.keys(ARGS).sort()).toEqual([...DESTRUCTIVE_TOOLS].sort());
  });

  it("client.listTools() registers exactly DESTRUCTIVE_TOOLS among the destructive tools", async () => {
    const ctx = ctxFor();
    const { client, close } = await connectAll(ctx);
    const { tools } = await client.listTools();
    const registeredDestructive = tools
      .map((t) => t.name)
      .filter((n) => (DESTRUCTIVE_TOOLS as readonly string[]).includes(n));
    expect(registeredDestructive.sort()).toEqual([...DESTRUCTIVE_TOOLS].sort());
    await close();
  });

  it("DESTRUCTIVE_TOOLS names all fifteen tools from the brief's table", () => {
    expect([...DESTRUCTIVE_TOOLS].sort()).toEqual(
      [
        "activate_plugin", "activate_theme", "cancel_batch", "deactivate_plugin",
        "delete_plugin", "delete_theme", "flush_cache", "flush_permalinks",
        "install_gsc_verification", "remove_gsc_verification", "set_maintenance",
        "update_all_plugins_fleet", "update_core", "update_plugins", "update_themes",
      ].sort(),
    );
  });
});

describe.each(DESTRUCTIVE_TOOLS)("%s", (name) => {
  it("previews and performs nothing when confirm is omitted", async () => {
    const ctx = ctxFor();
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name, arguments: ARGS[name] });
    expect(isError(res)).toBe(false);
    expect(textOf(res)).toMatch(/dry run/i);
    expect(ctx.serviceCalls).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });

  it("errors when confirm is true but no reason is given", async () => {
    const ctx = ctxFor();
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name, arguments: { ...ARGS[name], confirm: true } });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/reason is required/i);
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("performs the action and audits it with confirm and a reason", async () => {
    const ctx = ctxFor();
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name, arguments: { ...ARGS[name], confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(false);
    expect(ctx.serviceCalls.length).toBe(1);
    expect(ctx.audited).toHaveLength(1);
    expect(ctx.audited[0].action).toBe(`mcp.${name}`);
    expect(JSON.stringify(ctx.audited[0].detail)).toContain(REASON);
    // The audited args must carry this tool's actual target (plugin_file,
    // slug, slugs, enable, batch_id, environment, file_name -- whatever
    // ARGS[name] declares beyond site_id) unredacted, not merely a reason
    // string somewhere in the JSON blob.
    const target = Object.fromEntries(
      Object.entries(ARGS[name]).filter(([k]) => k !== "site_id"),
    );
    expect(ctx.audited[0].detail.args).toMatchObject(target);
    await close();
  });

  it("audits a failed live action instead of letting it go unrecorded", async () => {
    const ctx = ctxFor();
    const setup = FAIL_SEAM[name];
    if (setup) {
      setup(ctx);
    } else {
      (ctx as unknown as { manageSite: () => Promise<{ ok: boolean; error?: string }> })
        .manageSite = async () => {
          ctx.serviceCalls.push("manageSite");
          return { ok: false, error: "the site refused" };
        };
    }
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name, arguments: { ...ARGS[name], confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("the site refused");
    expect(ctx.audited).toHaveLength(1);
    expect(ctx.audited[0].detail.ok).toBe(false);
    await close();
  });

  it("refuses an ungranted caller before any confirm gate -- no preview leak", async () => {
    const ctx = ctxFor({ grants: [], permissions: [...PERMISSIONS_WITHOUT_VIEW_ALL] });
    const { client, close } = await connectAll(ctx);
    // No `confirm` at all: if gateConfirm ran before the access/existence
    // check, this would still hit the confirm-omitted branch and return a
    // dry-run preview -- naming a site (or batch) this caller has no grant
    // on. The access guard must fire first, regardless of confirm.
    const res = await client.callTool({ name, arguments: ARGS[name] });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(UNGRANTED_REFUSAL[name] ?? /not found/i);
    expect(textOf(res)).not.toMatch(/dry run/i);
    expect(ctx.serviceCalls).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });

  it("refuses on a read-only token, blaming the token and not a permission", async () => {
    const ctx = ctxFor({ readOnly: true });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name, arguments: { ...ARGS[name], confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/read-only/i);
    expect(textOf(res)).not.toMatch(/permission/i);
    expect(ctx.serviceCalls).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });

  it("refuses when the viewer holds no permissions at all", async () => {
    const ctx = ctxFor({ permissions: [] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name, arguments: { ...ARGS[name], confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(true);
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });
});

describe("update_themes", () => {
  it("builds one update_theme action per slug", async () => {
    const ctx = ctxFor();
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "update_themes",
      arguments: {
        site_id: SITE_ID, slugs: ["twentytwentyfour", "twentytwentythree"],
        confirm: true, reason: REASON,
      },
    });
    expect(isError(res)).toBe(false);
    expect(ctx.serviceCalls.length).toBe(2);
    await close();
  });

  it("still succeeds and reports both when one slug fails", async () => {
    const ctx = ctxFor();
    let call = 0;
    (ctx as unknown as { manageSite: () => Promise<{ ok: boolean; output?: string; error?: string }> })
      .manageSite = async () => {
        call += 1;
        ctx.serviceCalls.push("manageSite");
        return call === 1
          ? { ok: true, output: "Theme updated" }
          : { ok: false, error: "No update available" };
      };
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "update_themes",
      arguments: {
        site_id: SITE_ID, slugs: ["twentytwentyfour", "twentytwentythree"],
        confirm: true, reason: REASON,
      },
    });
    expect(isError(res)).toBe(false);
    const out = JSON.parse(textOf(res));
    expect(out.results).toHaveLength(2);
    expect(out.results.some((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(out.results.some((r: { ok: boolean }) => !r.ok)).toBe(true);
    expect(ctx.audited).toHaveLength(1);
    expect(ctx.audited[0].detail.args).toMatchObject({
      slugs: ["twentytwentyfour", "twentytwentythree"],
    });
    // A 1-of-2 success must not read as an unqualified success in the audit
    // row: ok is false, partial is explicit, and the failed slug is named.
    expect(ctx.audited[0].detail.ok).toBe(false);
    expect(ctx.audited[0].detail.partial).toBe(true);
    expect(ctx.audited[0].detail.results).toEqual([
      { slug: "twentytwentyfour", ok: true },
      { slug: "twentytwentythree", ok: false, error: "No update available" },
    ]);
    await close();
  });

  it("fails the tool only when every slug fails", async () => {
    const ctx = ctxFor();
    (ctx as unknown as { manageSite: () => Promise<{ ok: boolean; error?: string }> })
      .manageSite = async () => {
        ctx.serviceCalls.push("manageSite");
        return { ok: false, error: "No update available" };
      };
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "update_themes",
      arguments: { site_id: SITE_ID, slugs: ["twentytwentyfour"], confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(true);
    await close();
  });
});

describe("update_plugins", () => {
  it("builds update_all_plugins when plugin_file is omitted", async () => {
    const ctx = ctxFor();
    const seen: unknown[] = [];
    (ctx as unknown as { manageSite: (...a: unknown[]) => Promise<{ ok: boolean; output?: string }> })
      .manageSite = async (...a: unknown[]) => {
        seen.push(a[3]);
        ctx.serviceCalls.push("manageSite");
        return { ok: true, output: "Done" };
      };
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "update_plugins", arguments: { site_id: SITE_ID, confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(false);
    expect(seen[0]).toEqual({ kind: "update_all_plugins" });
    await close();
  });

  it("builds update_plugin when plugin_file is given", async () => {
    const ctx = ctxFor();
    const seen: unknown[] = [];
    (ctx as unknown as { manageSite: (...a: unknown[]) => Promise<{ ok: boolean; output?: string }> })
      .manageSite = async (...a: unknown[]) => {
        seen.push(a[3]);
        ctx.serviceCalls.push("manageSite");
        return { ok: true, output: "Done" };
      };
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "update_plugins",
      arguments: {
        site_id: SITE_ID, plugin_file: "akismet/akismet.php", confirm: true, reason: REASON,
      },
    });
    expect(isError(res)).toBe(false);
    expect(seen[0]).toEqual({ kind: "update_plugin", file: "akismet/akismet.php" });
    await close();
  });

  it("rejects an empty plugin_file at the schema instead of escalating to update-all", async () => {
    const ctx = ctxFor();
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "update_plugins",
      arguments: {
        site_id: SITE_ID, plugin_file: "", confirm: true, reason: REASON,
      },
    });
    expect(isError(res)).toBe(true);
    expect(ctx.serviceCalls).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });
});

describe("set_maintenance", () => {
  it("previews differently for enable true vs false", async () => {
    const ctxOn = ctxFor();
    const { client: clientOn, close: closeOn } = await connectAll(ctxOn);
    const onRes = await clientOn.callTool({
      name: "set_maintenance", arguments: { site_id: SITE_ID, enable: true },
    });
    await closeOn();

    const ctxOff = ctxFor();
    const { client: clientOff, close: closeOff } = await connectAll(ctxOff);
    const offRes = await clientOff.callTool({
      name: "set_maintenance", arguments: { site_id: SITE_ID, enable: false },
    });
    await closeOff();

    expect(textOf(onRes)).not.toEqual(textOf(offRes));
    expect(textOf(onRes).toLowerCase()).toContain("enable");
    expect(textOf(offRes).toLowerCase()).toContain("disable");
  });
});

describe("update_all_plugins_fleet", () => {
  it("fails clearly, enqueues nothing, and audits nothing when no site is eligible", async () => {
    const ctx = ctxFor();
    (ctx as unknown as {
      planFleetPluginUpdate: () => Promise<{ eligible: unknown[]; alreadyQueued: unknown[]; noUpdates: unknown[] }>;
    }).planFleetPluginUpdate = async () => ({ eligible: [], alreadyQueued: [], noUpdates: [{ id: SITE_ID }] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "update_all_plugins_fleet",
      arguments: { environment: "staging", confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(true);
    expect(ctx.serviceCalls).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });
});

describe("cancel_batch", () => {
  it("reports not found, not an empty preview, when every job in the batch is on an invisible site", async () => {
    // permissions carries queue.process so the refusal below is proven to
    // come from the visibility check, not from requirePermission firing
    // first and masking it.
    const ctx = ctxFor({ permissions: ["queue.process"], grants: [] });
    (ctx as unknown as {
      jobsRead: { batchJobs: () => Promise<{ id: string; site_id: string; status: string }[]> };
    }).jobsRead.batchJobs = async () => [
      { id: "job-1", site_id: "2c7f4e5a-6d8f-4b03-9e4c-7a5d3b1f8c62", status: "pending" },
    ];
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "cancel_batch",
      arguments: { batch_id: BATCH_ID, confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
    expect(ctx.serviceCalls).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });
});

describe("install_gsc_verification", () => {
  it("fails cleanly, not with a thrown error, for a file name Google never issued", async () => {
    const ctx = ctxFor();
    (ctx as unknown as { gsc: { install: typeof installVerificationFile } })
      .gsc.install = installVerificationFile;
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "install_gsc_verification",
      arguments: { site_id: SITE_ID, file_name: "not-a-real-verification-file.html", confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/google/i);
    await close();
  });
});

describe("remove_gsc_verification", () => {
  it("rejects a missing file_name at the schema layer, never reaching the seam", async () => {
    const ctx = ctxFor();
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name: "remove_gsc_verification",
      arguments: { site_id: SITE_ID, confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(true);
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });
});
