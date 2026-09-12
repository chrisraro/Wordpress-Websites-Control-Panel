import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import { ok, fail, ENVIRONMENT_NOTE, CONFIRM_SHAPE, gateConfirm, redactArgs } from "../confirm";
import { siteSummary } from "./sites";
import { loadSite } from "./manage";
import type { ToolCtx } from "../context";
import { siteEnvironment } from "@/services/sites/portfolio";
import { friendlySiteError } from "@/lib/mcp/errors";
import { GSC_FILE_RE } from "@/services/gsc/types";

const PERMISSION = "sites.manage" as const;

/**
 * Validates the file name at the schema layer, before the confirm gate --
 * the same shape check `installVerificationFile`/`removeVerificationFile`
 * run internally (src/services/gsc/types.ts#validateVerificationFileName),
 * duplicated here for the same reason manage.ts's PLUGIN_FILE_RE is: a name
 * Google never issued should fail before a dry run ever previews installing
 * or removing it, not after a confirm reaches the seam and writes an
 * `ok: false` audit row for an action that was never attempted.
 */
const FILE_NAME_SCHEMA = z
  .string()
  .regex(GSC_FILE_RE, "Expected a name like google1234abcd5678.html -- copy it exactly from Search Console.");

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "install_gsc_verification",
    {
      description:
        "Install a Google Search Console HTML verification file on a site " +
        "-- copy the file name exactly from Search Console, e.g. " +
        "google1234abcd5678.html. The file is written and then fetched back " +
        "over the public web to check it is actually reachable there: " +
        "writing it does not by itself prove Google can read it. This " +
        "panel can only tell whether a verification is INSTALLED, never " +
        `whether Google has VERIFIED the property. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        file_name: FILE_NAME_SCHEMA.describe(
          "The verification file name Google gave you, e.g. google1234abcd5678.html. " +
          "Copy it exactly -- a mismatched name is the most common way this fails.",
        ),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, file_name } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const gate = gateConfirm(
        ctx.auth, args,
        `Would install the verification file ${file_name} on ${site.name} (${siteEnvironment(site)}), ` +
        "replacing any existing file of that name, then fetch it back to check it is reachable.",
        { site: siteSummary(site), file_name },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await ctx.gsc.install(ctx.gsc.deps, site_id, file_name);
        await ctx.audit("mcp.install_gsc_verification", site_id, {
          reason: gate.reason, args: redactArgs(args), ok: true,
        });
        return ok({
          site: siteSummary(site),
          ...result,
          ...(result.reachable ? {} : {
            note:
              "The file was written but is not publicly fetchable, so Google's verification will " +
              "fail until that is resolved -- a CDN, a security plugin, or a cache in front of the " +
              "site are the usual causes.",
          }),
        });
      } catch (e) {
        const message = friendlySiteError(e);
        await ctx.audit("mcp.install_gsc_verification", site_id, {
          reason: gate.reason, args: redactArgs(args), ok: false, error: message,
        });
        return fail(message);
      }
    },
  );

  server.registerTool(
    "remove_gsc_verification",
    {
      description:
        "Remove a Google Search Console HTML verification file from a " +
        `site's document root. This cannot be undone from the panel. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        file_name: FILE_NAME_SCHEMA.describe("The verification file name to remove, e.g. google1234abcd5678.html."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, file_name } = args;
      const loaded = await loadSite(ctx, site_id, PERMISSION);
      if ("result" in loaded) return loaded.result;
      const { site } = loaded;

      const gate = gateConfirm(
        ctx.auth, args,
        `Would remove the verification file ${file_name} from ${site.name} (${siteEnvironment(site)}). ` +
        "This cannot be undone from the panel.",
        { site: siteSummary(site), file_name },
      );
      if (!gate.proceed) return gate.result;

      try {
        await ctx.gsc.remove(ctx.gsc.deps, site_id, file_name);
        await ctx.audit("mcp.remove_gsc_verification", site_id, {
          reason: gate.reason, args: redactArgs(args), ok: true,
        });
        return ok({ site: siteSummary(site), file_name });
      } catch (e) {
        const message = friendlySiteError(e);
        await ctx.audit("mcp.remove_gsc_verification", site_id, {
          reason: gate.reason, args: redactArgs(args), ok: false, error: message,
        });
        return fail(message);
      }
    },
  );
}
