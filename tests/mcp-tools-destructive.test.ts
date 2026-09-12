import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DESTRUCTIVE_TOOLS } from "@/mcp/tools/manage";
import type { ToolCtx } from "@/mcp/context";
import { ctxFor, SITE_ID } from "./helpers/mcp-ctx";

const REASON = "Applying the September security patch set";

/**
 * Minimal valid arguments per tool, beyond confirm/reason.
 *
 * Task 10a builds only the eleven single-site tools registered by
 * src/mcp/tools/manage.ts. `DESTRUCTIVE_TOOLS` names all fifteen (per the
 * brief) so Task 10b only has to register `fleet.ts` and `gsc.ts` and
 * extend this map -- not touch the exported list.
 *
 * TODO(10b): add ARGS entries and register the modules for
 * update_all_plugins_fleet, cancel_batch, install_gsc_verification and
 * remove_gsc_verification, then delete this TODO.
 */
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
};

/** The eleven single-site tools this task registers. */
const REGISTERED_TOOLS = DESTRUCTIVE_TOOLS.filter((name) => name in ARGS);

async function connectAll(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const mod = await import("@/mcp/tools/manage");
  mod.register(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const isError = (r: unknown) => Boolean((r as { isError?: boolean }).isError);
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("coverage", () => {
  it("ARGS names exactly the eleven single-site tools this task registers", () => {
    expect(Object.keys(ARGS).sort()).toEqual([...REGISTERED_TOOLS].sort());
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

describe.each(REGISTERED_TOOLS)("%s", (name) => {
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
