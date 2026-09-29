import { siteEnvironment } from "./portfolio";
import type { SiteRow } from "./types";

/**
 * Rules for pairing a staging copy with its production site
 * (0026_site_production_pair.sql). Pure, so the server action and any future
 * MCP tool apply the same answer.
 *
 * The database only refuses a self-pair. Everything that depends on the
 * environment of either row is decided here, because a check constraint
 * cannot see the other row and one tied to this row's environment would
 * break "Mark as production" for every paired site.
 */
export function pairingProblem(
  staging: Pick<SiteRow, "id" | "name" | "url" | "client_label" | "environment">,
  production: Pick<SiteRow, "id" | "name" | "url" | "client_label" | "environment"> | null,
): string | null {
  if (siteEnvironment(staging) !== "staging") {
    return "Only a staging site can be paired with a production site.";
  }
  if (!production) return "That production site was not found.";
  if (production.id === staging.id) return "A site cannot be paired with itself.";
  if (siteEnvironment(production) !== "production") {
    return `${production.name} is not marked production. Pair a staging copy with the live site it was taken from.`;
  }
  return null;
}

/**
 * The pairing that should actually be shown. A row that was paired while
 * staging and later re-marked production keeps its column value (see the
 * migration header for why that is not a constraint); it must not go on
 * presenting itself as someone's copy.
 */
export function effectivePairId(
  site: Pick<SiteRow, "url" | "client_label" | "environment">,
  productionSiteId: string | null,
): string | null {
  if (!productionSiteId) return null;
  return siteEnvironment(site) === "staging" ? productionSiteId : null;
}
