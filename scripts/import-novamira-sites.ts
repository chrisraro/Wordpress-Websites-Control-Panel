/**
 * One-off migration: import the operator's Novamira MCP servers (Claude
 * Desktop's config) into the control panel as sites, without duplicating
 * the ones already connected.
 *
 * Source of truth: %APPDATA%\Claude\claude_desktop_config.json, key
 * "mcpServers" -- read directly from that path, never copied anywhere. An
 * entry counts as a WordPress site only if its `env` carries WP_API_URL,
 * WP_API_USERNAME and WP_API_PASSWORD; anything else (e.g.
 * `novamira-visual-onlinecre`, which has only
 * NOVAMIRA_VISUAL_WORKSPACE_URL) is reported as skipped, not guessed at.
 *
 * Dry run is the default: prints a table of exactly what would happen and
 * writes nothing anywhere -- no database row, no activity-log entry, no
 * file. Only `--apply` performs the import, via `addSite()`
 * (src/services/sites/service.ts), which connects to the site and
 * discovers its abilities *before* writing anything, exactly like the
 * "Connect a site" form -- a site with a stale application password fails
 * loudly here rather than landing broken in the panel. Even in dry run,
 * each non-duplicate candidate is connection-tested read-only (no DB
 * write), so the printed summary reflects real reachability, not just the
 * config file's shape.
 *
 * Credential handling is deliberately conservative throughout this file:
 * an application password is never passed to console.log/console.error,
 * never interpolated into a string that is printed, and never written to
 * a file. Usernames are masked beyond their first 3 characters wherever
 * they appear in output. See scripts/lib/novamira-import.ts#maskUsername.
 *
 * Requires the same env as scripts/bootstrap-admin.ts (NEXT_PUBLIC_
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_ENCRYPTION_KEY, all in
 * .env.local), plus BOOTSTRAP_ADMIN_EMAIL identifying the actor recorded
 * on each site.connect activity-log entry -- the same env var
 * bootstrap-admin.ts reads, resolved the same way (auth.admin.listUsers,
 * matched by email). This script never invites anyone: the admin must
 * already exist (run `npm run bootstrap:admin` first if not).
 *
 *   BOOTSTRAP_ADMIN_EMAIL=you@example.com npm run import:sites
 *   BOOTSTRAP_ADMIN_EMAIL=you@example.com npm run import:sites -- --apply
 *
 * Deliberately a script, not a migration: it reads a local desktop config
 * file that only ever exists on the operator's machine, never in any
 * other environment migrations run against.
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SitesDeps } from "@/services/sites/service";
import type { McpServerEntry } from "./lib/novamira-import";

// Same manual .env.local loader as scripts/bootstrap-admin.ts and
// scripts/verify-rls.ts -- this is a plain script, not a Next.js request,
// so nothing else populates process.env.
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}

// `node --experimental-strip-types` only erases type syntax -- it does not
// resolve the "@/*" path alias tsconfig.json (and the rest of the app)
// relies on. This hook maps "@/x" to src/x.ts for this process only, so
// addSite() and its dependencies can be imported unmodified rather than
// duplicated or reimplemented here. It must be registered before any
// "@/..." *value* import resolves, so every such import below is a dynamic
// import() inside main(), never a static import at module top level (a
// static import in this same file would be linked before this call runs).
// Type-only imports (see `import type` above) need no such handling: they
// are erased entirely and never reach module resolution.
//
// The same hook also appends ".ts" to extension-less relative imports, but
// only when the importing module is one of ours -- this script, its
// scripts/lib helper, or something under src/ (the app's own source uses
// bundler-style extensionless relative imports throughout, e.g.
// "./errors" inside src/lib/mcp/client.ts, since Next.js's bundler
// resolves those; plain Node ESM does not). tsc rejects an explicit ".ts"
// extension in the source (TS5097, allowImportingTsExtensions is off
// repo-wide) but Node needs one with no bundler involved. Scoping the
// check to `context.parentURL` under scripts/ or src/ keeps this from
// ever touching a dependency's own internal relative requires/imports
// (registerHooks applies process-wide, including inside node_modules).
const SCRIPTS_ROOT_URL = pathToFileURL(path.join(process.cwd(), "scripts") + path.sep).href;
const SRC_ROOT = path.join(process.cwd(), "src");
const SRC_ROOT_URL = pathToFileURL(SRC_ROOT + path.sep).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = pathToFileURL(path.join(SRC_ROOT, specifier.slice(2)) + ".ts").href;
      return nextResolve(target, context);
    }
    const parentURL = context.parentURL ?? "";
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !path.extname(specifier) &&
      (parentURL.startsWith(SCRIPTS_ROOT_URL) || parentURL.startsWith(SRC_ROOT_URL))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const APPLY = process.argv.includes("--apply");

interface Row {
  serverName: string;
  name: string;
  url: string;
  usernameMasked: string;
  clientLabel: string;
  outcome: "created" | "would-create" | "duplicate" | "not-wordpress" | "bad-url" | "failed";
  detail?: string;
}

async function findAdminUserId(db: SupabaseClient): Promise<string> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  if (!email) {
    throw new Error(
      "Set BOOTSTRAP_ADMIN_EMAIL to an already-bootstrapped admin's email " +
        "(same variable scripts/bootstrap-admin.ts uses). This script never invites anyone.",
    );
  }
  const perPage = 50;
  for (let page = 1; ; page++) {
    const { data: list, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const match = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (list.users.length < perPage) {
      throw new Error(`No auth user found for BOOTSTRAP_ADMIN_EMAIL=${email}. Run npm run bootstrap:admin first.`);
    }
  }
}

/**
 * Some failures surface an underlying HTTP response body verbatim (e.g. a
 * misconfigured endpoint returning an HTML page instead of an MCP error),
 * which can run to hundreds of KB and contains embedded newlines. Neither
 * belongs in a one-line table cell or a readable summary, so every detail
 * string is flattened and capped before being displayed -- this never
 * touches credentials (see maskUsername for the one field that can carry
 * one, and the header comment: appPassword itself is never put in a Row).
 */
function displayDetail(detail: string): string {
  const flat = detail.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

function printTable(rows: Row[]): void {
  const headers = ["Server", "Name", "URL", "Username", "Client label", "Outcome"] as const;
  const cells = rows.map((r) => [
    r.serverName,
    r.name,
    r.url,
    r.usernameMasked,
    r.clientLabel,
    r.detail ? `${r.outcome} (${displayDetail(r.detail)})` : r.outcome,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => row[i]!.length)),
  );
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(line([...headers]));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of cells) console.log(line(row));
}

async function main() {
  const importLib = await import("./lib/novamira-import");
  const { partitionMcpServers, deriveSiteUrl, findDuplicate, deriveSiteMeta, maskUsername } = importLib;

  const configPath =
    process.env.NOVAMIRA_CONFIG_PATH ??
    path.join(process.env.APPDATA ?? "", "Claude", "claude_desktop_config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Claude Desktop config not found at ${configPath}`);
  }
  const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, McpServerEntry>;
  };
  const servers = rawConfig.mcpServers ?? {};

  const { candidates, skipped: notWordPress } = partitionMcpServers(servers);

  const { createClient } = await import("@supabase/supabase-js");
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const rawServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !rawServiceKey) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.local)");
  }
  const db: SupabaseClient = createClient(rawUrl, rawServiceKey, { auth: { persistSession: false } });

  const { data: existingSites, error: sitesErr } = await db.from("sites").select("url");
  if (sitesErr) throw new Error(`Could not list existing sites: ${sitesErr.message}`);
  const existingUrls = (existingSites ?? []).map((s: { url: string }) => s.url);

  const rows: Row[] = [];
  for (const s of notWordPress) {
    rows.push({
      serverName: s.serverName, name: "", url: "", usernameMasked: "", clientLabel: "",
      outcome: "not-wordpress", detail: s.reason,
    });
  }

  const { supabaseSitesRepo } = await import("@/services/sites/repo");
  const { supabaseJobsRepo } = await import("@/services/jobs/repo");
  const { createSiteMcpClient } = await import("@/lib/mcp/client");
  const { addSite, mcpEndpointFor } = await import("@/services/sites/service");
  const { McpAuthError, McpConnectionError } = await import("@/lib/mcp/errors");

  // addSite enqueues each imported site's first snapshot_refresh itself
  // (src/services/sites/service.ts) -- this script only has to supply the
  // dependency, exactly like /sites/new's server action does.
  const deps: SitesDeps = { repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs: supabaseJobsRepo(db) };

  let adminId: string | undefined;
  if (APPLY) adminId = await findAdminUserId(db);

  for (const c of candidates) {
    const derived = deriveSiteUrl(c.mcpApiUrl);
    if (!derived.ok) {
      rows.push({
        serverName: c.serverName, name: "", url: "", usernameMasked: maskUsername(c.username),
        clientLabel: "", outcome: "bad-url", detail: derived.error,
      });
      continue;
    }

    const meta = deriveSiteMeta(derived.url);
    const usernameMasked = maskUsername(c.username);
    const dup = findDuplicate(derived.url, existingUrls);
    if (dup) {
      rows.push({
        serverName: c.serverName, name: meta.name, url: derived.url, usernameMasked,
        clientLabel: meta.clientLabel, outcome: "duplicate", detail: `already connected as ${dup}`,
      });
      continue;
    }

    if (APPLY) {
      try {
        await addSite(
          deps,
          { name: meta.name, url: derived.url, wpUsername: c.username, appPassword: c.appPassword, clientLabel: meta.clientLabel },
          adminId!,
        );
        rows.push({
          serverName: c.serverName, name: meta.name, url: derived.url, usernameMasked,
          clientLabel: meta.clientLabel, outcome: "created",
        });
      } catch (e) {
        rows.push({
          serverName: c.serverName, name: meta.name, url: derived.url, usernameMasked,
          clientLabel: meta.clientLabel, outcome: "failed",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      // Dry run: connection-test read-only, so the printed summary
      // reflects real reachability without writing a database row or an
      // activity-log entry.
      try {
        const client = await createSiteMcpClient({
          endpoint: mcpEndpointFor(derived.url),
          username: c.username,
          appPassword: c.appPassword,
        });
        try {
          await client.discoverAbilities();
        } finally {
          await client.close();
        }
        rows.push({
          serverName: c.serverName, name: meta.name, url: derived.url, usernameMasked,
          clientLabel: meta.clientLabel, outcome: "would-create",
        });
      } catch (e) {
        const detail =
          e instanceof McpAuthError ? "WordPress rejected the application password"
          : e instanceof McpConnectionError ? "could not reach the site's MCP endpoint"
          : e instanceof Error ? e.message : String(e);
        rows.push({
          serverName: c.serverName, name: meta.name, url: derived.url, usernameMasked,
          clientLabel: meta.clientLabel, outcome: "failed", detail,
        });
      }
    }
  }

  console.log(APPLY ? "Importing Novamira sites (--apply)\n" : "Dry run (no changes will be made) -- pass --apply to import\n");
  printTable(rows);

  const created = rows.filter((r) => r.outcome === "created" || r.outcome === "would-create").length;
  const duplicates = rows.filter((r) => r.outcome === "duplicate").length;
  const failed = rows.filter((r) => r.outcome === "failed" || r.outcome === "bad-url").length;
  const skippedNotWp = rows.filter((r) => r.outcome === "not-wordpress").length;

  console.log(
    `\nSummary: ${created} ${APPLY ? "created" : "would create"}, ` +
      `${duplicates} skipped as duplicate, ${failed} failed to connect, ` +
      `${skippedNotWp} skipped (not a WordPress site)`,
  );

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
