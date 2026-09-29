import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import {
  ok, fail, ENVIRONMENT_NOTE, CONFIRM_SHAPE, SKIP_BACKUP_SHAPE, gateConfirm, redactArgs, requirePermission,
} from "../confirm";
import { siteSummary, NOT_FOUND } from "./sites";
import type { ToolCtx } from "../context";
import { getSite } from "@/services/sites/service";
import { siteEnvironment } from "@/services/sites/portfolio";
import { friendlySiteError, siteText } from "@/lib/mcp/errors";
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

/** Site errors are capped at this length in tool output (siteText). */
const SITE_ERROR_MAX = 200;
/** Site-produced action output is longer by nature but still bounded. */
const SITE_OUTPUT_MAX = 1000;

/**
 * The site writes `output` and `error`; the model reading this tool's result
 * must not receive them as unbounded markup (audit 2026-09-29, open 5).
 */
function siteOutput(output: string | undefined): string | undefined {
  return output === undefined ? undefined : siteText(output, SITE_OUTPUT_MAX);
}

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

/**
 * The inline updates (update_plugins, update_themes, update_core) run
 * immediately, so they cannot wait for a backup: each is refused unless the
 * site's UpdraftPlus has a successful backup from the last 6 hours, unless
 * the caller passed skip_backup: true. Checked on the dry run as well as the
 * real call: a dry run for an update that would be refused must not hand out
 * a confirm code, and the backup can go stale (or fail) between the two.
 * Returns the refusal, or null to go ahead.
 */
async function inlineBackupRefusal(
  ctx: ToolCtx, site_id: string, skip_backup: boolean, what: string,
): Promise<ReturnType<typeof fail> | null> {
  if (skip_backup) return null;
  try {
    const backup = await ctx.backupReadyForInlineUpdate(ctx.backup, site_id);
    if (backup.ready) return null;
    return fail(
      `${backup.reason} To update ${what} without a backup, call again ` +
      "with skip_backup: true (a new dry run is needed).",
    );
  } catch (e) {
    return fail(friendlySiteError(e));
  }
}

/** How a dry-run preview ends, per skip_backup. */
function backupClause(skip_backup: boolean): string {
  return skip_backup
    ? "WITHOUT a backup (skip_backup: true)."
    : "after confirming a successful UpdraftPlus backup from the last 6 hours.";
}

const INLINE_BACKUP_NOTE =
  "Runs immediately, so it cannot wait for a backup: it is refused unless the " +
  "site's UpdraftPlus has a successful backup from the last 6 hours. Pass " +
  "skip_backup: true only when the user explicitly wants to update without " +
  "a backup.";

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "update_plugins",
    {
      description:
        "Update one plugin, or every plugin with an update available, on a " +
        `site. ${INLINE_BACKUP_NOTE} ${ENVIRONMENT_NOTE}`,
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
        ...SKIP_BACKUP_SHAPE,
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, plugin_file, skip_backup } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const refused = await inlineBackupRefusal(
        ctx, site_id, skip_backup, plugin_file !== undefined ? `the plugin ${plugin_file}` : "the plugins",
      );
      if (refused) return refused;

      const action: ManageAction = plugin_file !== undefined
        ? { kind: "update_plugin", file: plugin_file }
        : { kind: "update_all_plugins" };
      const summary = plugin_file !== undefined
        ? `Would update the plugin ${plugin_file} on ${site.name} (${siteEnvironment(site)}), `
        : `Would update every plugin with an update available on ${site.name} (${siteEnvironment(site)}), `;

      const gate = gateConfirm(
        ctx.auth, "update_plugins", args, summary + backupClause(skip_backup),
        { site: siteSummary(site), plugin_file, backup: skip_backup ? "skip" : "required" },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(ctx, "update_plugins", site_id, action, gate.reason, args);
        return result.ok
          ? ok({ site: siteSummary(site), output: siteOutput(result.output) })
          : fail(siteText(result.error ?? "The site rejected the update.", SITE_ERROR_MAX));
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  // One theme per call, deliberately (final review, Fix 2). A multi-slug
  // loop would make several `manageSite` calls per invocation: a throw on
  // the second slug left the first updated with no audit row, and two slow
  // themes at ACTION_TIMEOUT_MS each could outrun the route's maxDuration.
  // The tool keeps its spec name; an LLM updating several themes calls it
  // once per theme, each call audited on its own.
  server.registerTool(
    "update_themes",
    {
      description:
        "Update one theme with an update available on a site. Updates a single " +
        "theme per call; call once per theme to update several. " +
        `${INLINE_BACKUP_NOTE} ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        slug: z.string().regex(SLUG_RE).describe("The theme's stylesheet slug, e.g. twentytwentyfour, from get_inventory."),
        ...SKIP_BACKUP_SHAPE,
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, slug, skip_backup } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const refused = await inlineBackupRefusal(ctx, site_id, skip_backup, `the theme ${slug}`);
      if (refused) return refused;

      const gate = gateConfirm(
        ctx.auth, "update_themes", args,
        `Would update the theme ${slug} on ${site.name} (${siteEnvironment(site)}), ${backupClause(skip_backup)}`,
        { site: siteSummary(site), slug, backup: skip_backup ? "skip" : "required" },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "update_themes", site_id, { kind: "update_theme", slug }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), slug, output: siteOutput(result.output) })
          : fail(siteText(result.error ?? "The site rejected the theme update.", SITE_ERROR_MAX));
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "update_core",
    {
      description:
        "Update WordPress core on a site, including its database upgrade. " +
        `${INLINE_BACKUP_NOTE} ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        ...SKIP_BACKUP_SHAPE,
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, skip_backup } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const refused = await inlineBackupRefusal(ctx, site_id, skip_backup, "WordPress core");
      if (refused) return refused;

      const gate = gateConfirm(
        ctx.auth, "update_core", args,
        `Would update WordPress core on ${site.name} (${siteEnvironment(site)}), including its database upgrade, ` +
        backupClause(skip_backup),
        { site: siteSummary(site), backup: skip_backup ? "skip" : "required" },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(ctx, "update_core", site_id, { kind: "update_core" }, gate.reason, args);
        return result.ok
          ? ok({ site: siteSummary(site), output: siteOutput(result.output) })
          : fail(siteText(result.error ?? "The site rejected the core update.", SITE_ERROR_MAX));
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
        ctx.auth, "activate_plugin", args,
        `Would activate the plugin ${plugin_file} on ${site.name} (${siteEnvironment(site)}).`,
        { site: siteSummary(site), plugin_file },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "activate_plugin", site_id, { kind: "activate_plugin", file: plugin_file }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), plugin_file, output: siteOutput(result.output) })
          : fail(siteText(result.error ?? "The site rejected the activation.", SITE_ERROR_MAX));
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
        ctx.auth, "deactivate_plugin", args,
        `Would deactivate the plugin ${plugin_file} on ${site.name} (${siteEnvironment(site)}).`,
        { site: siteSummary(site), plugin_file },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "deactivate_plugin", site_id, { kind: "deactivate_plugin", file: plugin_file }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), plugin_file, output: siteOutput(result.output) })
          : fail(siteText(result.error ?? "The site rejected the deactivation.", SITE_ERROR_MAX));
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
        ctx.auth, "delete_plugin", args,
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
          ? ok({ site: siteSummary(site), plugin_file, output: siteOutput(result.output) })
          : fail(siteText(result.error ?? "The site rejected the deletion.", SITE_ERROR_MAX));
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
        ctx.auth, "activate_theme", args,
        `Would activate the theme ${slug} on ${site.name} (${siteEnvironment(site)}).`,
        { site: siteSummary(site), slug },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "activate_theme", site_id, { kind: "activate_theme", slug }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), slug, output: siteOutput(result.output) })
          : fail(siteText(result.error ?? "The site rejected the activation.", SITE_ERROR_MAX));
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
        ctx.auth, "delete_theme", args,
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
          ? ok({ site: siteSummary(site), slug, output: siteOutput(result.output) })
          : fail(siteText(result.error ?? "The site rejected the deletion.", SITE_ERROR_MAX));
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

      const gate = gateConfirm(ctx.auth, "set_maintenance", args, summary, { site: siteSummary(site), enable });
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(
          ctx, "set_maintenance", site_id, { kind: "maintenance", enable }, gate.reason, args,
        );
        return result.ok
          ? ok({ site: siteSummary(site), enable, output: siteOutput(result.output) })
          : fail(siteText(result.error ?? "The site rejected the request.", SITE_ERROR_MAX));
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
        ctx.auth, "flush_cache", args,
        `Would flush the object cache on ${site.name} (${siteEnvironment(site)}). ` +
        "Low-risk: the cache simply repopulates on the next request.",
        { site: siteSummary(site) },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await perform(ctx, "flush_cache", site_id, { kind: "flush_cache" }, gate.reason, args);
        return result.ok
          ? ok({ site: siteSummary(site), output: siteOutput(result.output) })
          : fail(siteText(result.error ?? "The site rejected the request.", SITE_ERROR_MAX));
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
        ctx.auth, "flush_permalinks", args,
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
          ? ok({ site: siteSummary(site), output: siteOutput(result.output) })
          : fail(siteText(result.error ?? "The site rejected the request.", SITE_ERROR_MAX));
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
