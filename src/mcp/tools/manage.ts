import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import {
  ok, fail, ENVIRONMENT_NOTE, CONFIRM_SHAPE, gateConfirm, redactArgs, requirePermission,
} from "../confirm";
import { siteSummary, NOT_FOUND } from "./sites";
import type { ToolCtx } from "../context";
import { getSite } from "@/services/sites/service";
import { siteEnvironment } from "@/services/sites/portfolio";
import { friendlySiteError } from "@/lib/mcp/errors";
import { canAccessSite } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";
import type { ManageAction } from "@/services/manage/types";
import type { SiteRow } from "@/services/sites/types";
import { PLUGIN_FILE_RE, SLUG_RE } from "@/services/manage/service";

/**
 * All fifteen destructive tools per the task-10 brief's table, so a tool
 * cannot be added without appearing here. Task 10a (this file) registers
 * only the first eleven, single-site ones. The remaining four --
 * `update_all_plugins_fleet`, `cancel_batch`, `install_gsc_verification`,
 * `remove_gsc_verification` -- are registered by Task 10b's `fleet.ts` and
 * `gsc.ts` (plus `cancel_batch` added to jobs.ts); this list already names
 * them so 10b only has to register modules, never edit this export.
 */
export const DESTRUCTIVE_TOOLS = [
  "update_plugins", "update_themes", "update_core",
  "activate_plugin", "deactivate_plugin", "delete_plugin",
  "activate_theme", "delete_theme",
  "set_maintenance", "flush_cache", "flush_permalinks",
  "update_all_plugins_fleet", "cancel_batch",
  "install_gsc_verification", "remove_gsc_verification",
] as const;

const PERMISSION = "wp_toolkit.manage" as const;

/**
 * Runs the guard order every destructive single-site tool shares --
 * permission, then site access, then existence -- and returns either the
 * refusal or the resolved site. Order matters and is pinned by tests:
 * gating on confirm before site access would tell a caller that a site they
 * cannot see exists, because the preview would name it.
 *
 * Parameterised on `permission` (rather than hardcoding this file's
 * `wp_toolkit.manage`) so Task 10b's `gsc.ts` -- gated on `sites.manage`
 * instead -- can reuse the exact same guard order without copying it.
 * Every call site in this file still passes the local `PERMISSION` constant.
 */
export async function loadSite(
  ctx: ToolCtx, site_id: string, permission: AppPermission,
): Promise<{ result: ReturnType<typeof fail> } | { site: SiteRow }> {
  const permDenied = requirePermission(ctx.auth, permission);
  if (permDenied) return { result: permDenied };
  if (!canAccessSite(ctx.auth.viewer, site_id, "manage")) return { result: fail(NOT_FOUND) };

  const site = await getSite(ctx.sites, site_id);
  if (!site) return { result: fail(NOT_FOUND) };
  return { site };
}

/**
 * Runs one ManageAction through the injected seam, then audits the outcome.
 *
 * `manageSite` normally catches its own failures and returns `{ ok: false }`,
 * which is what the happy-path audit line below records. A thrown exception
 * is audited too, on the way back out -- see ToolCtx#audit's docstring for
 * the rule this keeps in step with the other destructive tools' seams.
 */
async function perform(
  ctx: ToolCtx, toolName: string, site_id: string, action: ManageAction, reason: string, args: unknown,
) {
  try {
    const result = await ctx.manageSite(ctx.manage, site_id, ctx.auth.viewer.id, action);
    await ctx.audit(`mcp.${toolName}`, site_id, {
      reason, args: redactArgs(args as Record<string, unknown>), ok: result.ok,
    });
    return result;
  } catch (e) {
    await ctx.audit(`mcp.${toolName}`, site_id, {
      reason, args: redactArgs(args as Record<string, unknown>), ok: false, error: friendlySiteError(e),
    });
    throw e;
  }
}

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "update_plugins",
    {
      description:
        "Update one plugin, or every plugin with an update available, on a " +
        `site. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        plugin_file: z
          .string()
          .min(1)
          .regex(PLUGIN_FILE_RE)
          .optional()
          .describe(
            "One plugin's file, e.g. akismet/akismet.php, from get_inventory. " +
            "Omit to update every plugin with an update available.",
          ),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, plugin_file } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const action: ManageAction = plugin_file !== undefined
        ? { kind: "update_plugin", file: plugin_file }
        : { kind: "update_all_plugins" };
      const summary = plugin_file !== undefined
        ? `Would update the plugin ${plugin_file} on ${site.name} (${siteEnvironment(site)}).`
        : `Would update every plugin with an update available on ${site.name} (${siteEnvironment(site)}).`;

      const gate = gateConfirm(ctx.auth, args, summary, { site: siteSummary(site), plugin_file });
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(ctx, "update_plugins", site_id, action, gate.reason, args);
        return result.ok
          ? ok({ site: siteSummary(site), output: result.output })
          : fail(result.error ?? "The site rejected the update.");
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "update_themes",
    {
      description:
        "Update one or more themes, each with an update available, on a " +
        `site. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        slugs: z
          .array(z.string().regex(SLUG_RE))
          .min(1)
          .describe("Theme stylesheet slugs to update, e.g. twentytwentyfour, from get_inventory."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, slugs } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const gate = gateConfirm(
        ctx.auth, args,
        `Would update ${slugs.length} theme(s) (${slugs.join(", ")}) on ${site.name} (${siteEnvironment(site)}).`,
        { site: siteSummary(site), slugs },
      );
      if (!gate.proceed) return gate.result;

      try {
        const results: { slug: string; ok: boolean; output?: string; error?: string }[] = [];
        for (const slug of slugs) {
          const r = await ctx.manageSite(ctx.manage, site_id, ctx.auth.viewer.id, {
            kind: "update_theme", slug,
          });
          results.push({ slug, ok: r.ok, output: r.output, error: r.error });
        }
        const allOk = results.every((r) => r.ok);
        const anyOk = results.some((r) => r.ok);
        await ctx.audit("mcp.update_themes", site_id, {
          reason: gate.reason,
          args: redactArgs(args),
          ok: allOk,
          results: results.map((r) => ({ slug: r.slug, ok: r.ok, ...(r.error !== undefined ? { error: r.error } : {}) })),
          ...(anyOk && !allOk ? { partial: true } : {}),
        });
        return anyOk
          ? ok({ site: siteSummary(site), results })
          : fail(`All theme updates failed: ${results.map((r) => `${r.slug} (${r.error})`).join("; ")}`);
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "update_core",
    {
      description: `Update WordPress core on a site, including its database upgrade. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const gate = gateConfirm(
        ctx.auth, args,
        `Would update WordPress core on ${site.name} (${siteEnvironment(site)}), including its database upgrade.`,
        { site: siteSummary(site) },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(ctx, "update_core", site_id, { kind: "update_core" }, gate.reason, args);
        return result.ok
          ? ok({ site: siteSummary(site), output: result.output })
          : fail(result.error ?? "The site rejected the core update.");
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "activate_plugin",
    {
      description: `Activate an installed plugin on a site. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        plugin_file: z
          .string()
          .regex(PLUGIN_FILE_RE)
          .describe("The plugin's file, e.g. akismet/akismet.php, from get_inventory."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, plugin_file } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const gate = gateConfirm(
        ctx.auth, args,
        `Would activate the plugin ${plugin_file} on ${site.name} (${siteEnvironment(site)}).`,
        { site: siteSummary(site), plugin_file },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "activate_plugin", site_id, { kind: "activate_plugin", file: plugin_file }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), plugin_file, output: result.output })
          : fail(result.error ?? "The site rejected the activation.");
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "deactivate_plugin",
    {
      description: `Deactivate an active plugin on a site. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        plugin_file: z
          .string()
          .regex(PLUGIN_FILE_RE)
          .describe("The plugin's file, e.g. akismet/akismet.php, from get_inventory."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, plugin_file } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const gate = gateConfirm(
        ctx.auth, args,
        `Would deactivate the plugin ${plugin_file} on ${site.name} (${siteEnvironment(site)}).`,
        { site: siteSummary(site), plugin_file },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "deactivate_plugin", site_id, { kind: "deactivate_plugin", file: plugin_file }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), plugin_file, output: result.output })
          : fail(result.error ?? "The site rejected the deactivation.");
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "delete_plugin",
    {
      description:
        "Permanently delete a plugin from a site. Its files are removed; its data " +
        "in the database is not. This cannot be undone from the panel. " +
        `${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        plugin_file: z
          .string()
          .regex(PLUGIN_FILE_RE)
          .describe("The plugin's file, e.g. akismet/akismet.php, from get_inventory."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, plugin_file } = args;

      // Order matters, and the tests pin it: permission, then site access,
      // then existence, then the confirm gate. Gating on confirm before site
      // access would tell a caller that a site they cannot see exists.
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const gate = gateConfirm(
        ctx.auth, args,
        `Would permanently delete the plugin ${plugin_file} from ${site.name} ` +
        `(${siteEnvironment(site)}). Its files are removed and cannot be restored from the panel.`,
        { site: siteSummary(site), plugin_file },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "delete_plugin", site_id, { kind: "delete_plugin", file: plugin_file }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), plugin_file, output: result.output })
          : fail(result.error ?? "The site rejected the deletion.");
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "activate_theme",
    {
      description: `Activate an installed theme on a site. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        slug: z.string().regex(SLUG_RE).describe("The theme's stylesheet slug, e.g. twentytwentyfour, from get_inventory."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, slug } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const gate = gateConfirm(
        ctx.auth, args,
        `Would activate the theme ${slug} on ${site.name} (${siteEnvironment(site)}).`,
        { site: siteSummary(site), slug },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "activate_theme", site_id, { kind: "activate_theme", slug }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), slug, output: result.output })
          : fail(result.error ?? "The site rejected the activation.");
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "delete_theme",
    {
      description:
        "Permanently delete a theme from a site. Its files are removed. This " +
        `cannot be undone from the panel. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        slug: z.string().regex(SLUG_RE).describe("The theme's stylesheet slug, e.g. twentytwentyfour, from get_inventory."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, slug } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const gate = gateConfirm(
        ctx.auth, args,
        `Would permanently delete the theme ${slug} from ${site.name} (${siteEnvironment(site)}). ` +
        "Its files are removed and cannot be restored from the panel.",
        { site: siteSummary(site), slug },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "delete_theme", site_id, { kind: "delete_theme", slug }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), slug, output: result.output })
          : fail(result.error ?? "The site rejected the deletion.");
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "set_maintenance",
    {
      description:
        "Turn a site's maintenance mode on or off, showing visitors a " +
        `maintenance page instead of the normal site while enabled. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        enable: z.boolean().describe("true to enable maintenance mode, false to disable it."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, enable } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const summary = enable
        ? `Would enable maintenance mode on ${site.name} (${siteEnvironment(site)}), ` +
          "showing visitors a maintenance page until it is disabled again."
        : `Would disable maintenance mode on ${site.name} (${siteEnvironment(site)}), ` +
          "restoring normal access for visitors.";

      const gate = gateConfirm(ctx.auth, args, summary, { site: siteSummary(site), enable });
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "set_maintenance", site_id, { kind: "maintenance", enable }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), enable, output: result.output })
          : fail(result.error ?? "The site rejected the request.");
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "flush_cache",
    {
      description:
        "Flush a site's WordPress object cache. Low-risk and reversible -- " +
        "the cache simply repopulates on the next request. Still gated, like " +
        `every write this server can make. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const gate = gateConfirm(
        ctx.auth, args,
        `Would flush the object cache on ${site.name} (${siteEnvironment(site)}). ` +
        "Low-risk: the cache simply repopulates on the next request.",
        { site: siteSummary(site) },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(ctx, "flush_cache", site_id, { kind: "flush_cache" }, gate.reason, args);
        return result.ok
          ? ok({ site: siteSummary(site), output: result.output })
          : fail(result.error ?? "The site rejected the request.");
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "flush_permalinks",
    {
      description:
        "Flush a site's rewrite rules (permalinks). Low-risk and reversible -- " +
        "WordPress regenerates them from the current settings. Still gated, " +
        `like every write this server can make. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const gate = gateConfirm(
        ctx.auth, args,
        `Would flush the rewrite rules (permalinks) on ${site.name} (${siteEnvironment(site)}). ` +
        "Low-risk: WordPress regenerates them from the current settings.",
        { site: siteSummary(site) },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "flush_permalinks", site_id, { kind: "flush_permalinks" }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), output: result.output })
          : fail(result.error ?? "The site rejected the request.");
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
