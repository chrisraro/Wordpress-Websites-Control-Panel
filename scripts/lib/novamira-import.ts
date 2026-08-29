/**
 * Pure helpers for scripts/import-novamira-sites.ts: parsing the Claude
 * Desktop MCP config, deriving a site's origin URL/name/label from its MCP
 * endpoint, and comparing a candidate against sites already in the panel.
 *
 * Deliberately free of file-system and network I/O so
 * tests/import-novamira-sites.test.ts can exercise every function here
 * directly, without touching the real config file, the database, or the
 * network.
 */
import { mcpEndpointFor } from "@/services/sites/service";

/**
 * The suffix `mcpEndpointFor` appends to a site's origin to get its MCP
 * endpoint. Read from the real function (called with an empty origin)
 * rather than duplicated as a literal here, so this file can never drift
 * from what `addSite` will actually connect to.
 */
const MCP_SUFFIX = mcpEndpointFor("");

export interface McpServerEntry {
  command?: unknown;
  args?: unknown;
  env?: Record<string, unknown>;
}

export interface WordPressCandidate {
  serverName: string;
  mcpApiUrl: string;
  username: string;
  appPassword: string;
}

export interface SkippedServer {
  serverName: string;
  reason: string;
}

/**
 * Split `mcpServers` entries into WordPress candidates (all three
 * WP_API_* env keys present and non-empty) and everything else. An entry
 * missing any of the three is not a WordPress site regardless of what
 * else its `env` carries -- e.g. `novamira-visual-onlinecre`, which has
 * only `NOVAMIRA_VISUAL_WORKSPACE_URL`.
 */
export function partitionMcpServers(
  servers: Record<string, McpServerEntry>,
): { candidates: WordPressCandidate[]; skipped: SkippedServer[] } {
  const candidates: WordPressCandidate[] = [];
  const skipped: SkippedServer[] = [];
  for (const [serverName, entry] of Object.entries(servers)) {
    const env = entry?.env ?? {};
    const url = env.WP_API_URL;
    const username = env.WP_API_USERNAME;
    const appPassword = env.WP_API_PASSWORD;
    const hasAll =
      typeof url === "string" && url.length > 0 &&
      typeof username === "string" && username.length > 0 &&
      typeof appPassword === "string" && appPassword.length > 0;
    if (hasAll) {
      candidates.push({
        serverName,
        mcpApiUrl: url as string,
        username: username as string,
        appPassword: appPassword as string,
      });
    } else {
      skipped.push({
        serverName,
        reason: "not a WordPress site (missing one or more of WP_API_URL/WP_API_USERNAME/WP_API_PASSWORD)",
      });
    }
  }
  return { candidates, skipped };
}

export type DeriveUrlResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Recover the site origin the panel should store from an MCP endpoint
 * URL, by stripping exactly the suffix `mcpEndpointFor` appends. Verified
 * by round-tripping the candidate origin back through the real function
 * rather than trusting a bare string slice, so a URL that merely
 * *contains* the suffix somewhere unexpected cannot slip through
 * silently -- it is reported and skipped instead, per spec.
 */
export function deriveSiteUrl(mcpApiUrl: string): DeriveUrlResult {
  const trimmed = mcpApiUrl.replace(/\/+$/, "");
  if (!trimmed.endsWith(MCP_SUFFIX)) {
    return { ok: false, error: `WP_API_URL does not end in "${MCP_SUFFIX}": ${mcpApiUrl}` };
  }
  const origin = trimmed.slice(0, -MCP_SUFFIX.length);
  if (!origin) {
    return { ok: false, error: `WP_API_URL has no origin before the MCP suffix: ${mcpApiUrl}` };
  }
  if (mcpEndpointFor(origin) !== trimmed) {
    return { ok: false, error: `Derived origin does not round-trip through mcpEndpointFor: ${mcpApiUrl}` };
  }
  return { ok: true, url: origin };
}

/**
 * Lowercase the host, strip trailing slashes. Used to compare a freshly
 * derived URL against `sites.url` rows already in the database. Path
 * segments deliberately keep their case: subdirectory installs are
 * case-sensitive on the server, and this must not collapse two distinct
 * hosts that merely share a registrable domain (elnidoguide.ph and
 * staging.elnidoguide.ph are different sites, not a duplicate).
 */
export function normalizeSiteUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.protocol = parsed.protocol.toLowerCase();
  return parsed.toString().replace(/\/+$/, "");
}

/** The existing `sites.url` this candidate duplicates, if any. */
export function findDuplicate(candidateUrl: string, existingUrls: string[]): string | undefined {
  const normalizedCandidate = normalizeSiteUrl(candidateUrl);
  return existingUrls.find((existing) => normalizeSiteUrl(existing) === normalizedCandidate);
}

// --- name derivation -----------------------------------------------------

/**
 * Compound domain/subdirectory labels that have no delimiter for the
 * generic splitter below to find (no hyphen, no case change) get their
 * words spelled out here. Deliberately small: it covers only the labels
 * where the generic hyphen/camelCase/digit-stripping split is genuinely
 * unable to recover the words on its own (a single run-together lowercase
 * string), not a name for every site being imported. Keyed by the label
 * lowercased, after any trailing digit run is stripped.
 */
const LABEL_OVERRIDES: Record<string, string[]> = {
  cherrybuspalawan: ["Cherry", "Bus", "Palawan"],
  azaleabaguio: ["Azalea", "Baguio"],
  azaleaboracay: ["Azalea", "Boracay"],
  beachbus: ["Beach", "Bus"],
  elnidoguide: ["El", "Nido", "Guide"],
  onlinecreativesolutions: ["Online", "Creative", "Solutions"],
  aralabroad: ["Aral", "Abroad"],
  // Subdirectory-only label (onlinecreativesolutions.com/cherrybus) --
  // distinct from cherrybuspalawan.ph above, so it needs its own entry.
  cherrybus: ["Cherry", "Bus"],
};

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Recover the words in one host/path label: override map, then
 * hyphen/underscore split, then camelCase boundaries, then -- if nothing
 * else applies -- the label as a single word. A trailing digit run
 * (`staging2` -> `staging`) is stripped first so "staging" is recognized
 * regardless of which numbered copy it is.
 */
function wordsForLabel(rawLabel: string): string[] {
  const noDigits = rawLabel.replace(/\d+$/, "");
  if (noDigits.length === 0) return [];
  const override = LABEL_OVERRIDES[noDigits.toLowerCase()];
  if (override) return override;
  if (/[-_]/.test(noDigits)) {
    return noDigits.split(/[-_]+/).filter(Boolean).flatMap(wordsForLabel);
  }
  if (/[a-z][A-Z]/.test(noDigits)) {
    return noDigits.split(/(?=[A-Z])/).filter(Boolean);
  }
  return [noDigits];
}

const STAGING_WORD = /^stag(e|ing)$/i;

export interface SiteMeta {
  name: string;
  clientLabel: string;
  isStaging: boolean;
}

/**
 * Derive a default display name and client label from a site's origin
 * URL (the value `deriveSiteUrl` returns, i.e. already stripped of the
 * MCP suffix).
 *
 * Root-domain sites are named from the host label alone. A site in a
 * subdirectory is always treated as staging: per spec, an install that
 * is not at its domain's root must never be mistaken for that domain's
 * production site during a bulk operation, whether or not the word
 * "staging" appears anywhere in the URL (onlinecreativesolutions.com/
 * AralAbroad does not contain it, but is a pre-launch copy of what is now
 * aralabroad.com, hosted in a subdirectory of the agency's own domain).
 *
 * A staging site's name prefers the subdirectory's own words over the
 * parent host's (AralAbroad -> "Aral Abroad (Staging)", not
 * "Online Creative Solutions (Staging)") unless the subdirectory's words
 * are already part of the host's name -- azaleabaguio.com/staging2-baguio
 * contributes only "baguio", which restates the host, so the host name is
 * reused instead of being duplicated: "Azalea Baguio (Staging)".
 */
export function deriveSiteMeta(url: string): SiteMeta {
  const parsed = new URL(url);
  const hostLabel = parsed.hostname.split(".")[0] ?? parsed.hostname;
  const baseWords = wordsForLabel(hostLabel);

  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const isStaging = pathSegments.length > 0;

  let brandWords = baseWords;
  if (isStaging) {
    const subWords = pathSegments.flatMap(wordsForLabel).filter((w) => !STAGING_WORD.test(w));
    const baseLower = new Set(baseWords.map((w) => w.toLowerCase()));
    const overlaps = subWords.some((w) => baseLower.has(w.toLowerCase()));
    if (subWords.length > 0 && !overlaps) brandWords = subWords;
  }

  const brand = brandWords.map(capitalize).join(" ");
  const name = isStaging ? `${brand} (Staging)` : brand;
  return { name, clientLabel: name, isStaging };
}

// --- masking ---------------------------------------------------------------

/**
 * Mask a WordPress username beyond its first 3 characters, for any
 * output this script produces (dry-run table, summary, errors). Never
 * called on a password -- passwords are never printed, logged, or
 * written anywhere, at any verbosity.
 */
export function maskUsername(username: string): string {
  if (username.length <= 3) return username;
  return username.slice(0, 3) + "*".repeat(username.length - 3);
}
