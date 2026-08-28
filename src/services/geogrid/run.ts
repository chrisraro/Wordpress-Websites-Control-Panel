import { buildGrid } from "./grid";
import type { GeoGridRepo } from "./repo";
import type { GeoGridProvider, GeoGridProviderName, RankPoint } from "./types";

export interface GeoGridRunDeps {
  geogrid: GeoGridRepo;
  providers: Record<GeoGridProviderName, GeoGridProvider>;
  appUrl: string;
}

export async function runGeoGrid(
  deps: GeoGridRunDeps, jobId: string, configId: string, keyword: string,
): Promise<{ awaiting: boolean }> {
  const config = await deps.geogrid.getConfig(configId);
  if (!config) throw new Error(`GeoGrid config not found: ${configId}`);

  const provider = deps.providers[config.provider];
  if (!provider) throw new Error(`Unknown GeoGrid provider: ${config.provider}`);

  // A callback URL pointing at localhost silently strands every n8n run, so
  // refuse up front with a message that names the fix.
  if (config.provider === "n8n" && /^https?:\/\/localhost(:|\/|$)/i.test(deps.appUrl)) {
    throw new Error("Set APP_URL to this app's public origin to use the n8n provider");
  }

  const points = buildGrid(config.center_lat, config.center_lng, config.grid_size, config.spacing_m);
  const outcome = await provider.run({
    runId: jobId,
    keyword,
    businessName: config.business_name,
    placeRef: config.place_ref,
    points,
    callbackUrl: `${deps.appUrl.replace(/\/+$/, "")}/api/webhooks/n8n/geogrid`,
  });

  if (outcome.kind === "ranks") {
    await deps.geogrid.insertSnapshot(configId, keyword, outcome.ranks);
    return { awaiting: false };
  }
  return { awaiting: true };
}

export async function completeGeoGridRun(
  repo: GeoGridRepo, configId: string, keyword: string, ranks: RankPoint[],
): Promise<void> {
  await repo.insertSnapshot(configId, keyword, ranks);
}
