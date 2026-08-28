import { decryptSecret } from "@/lib/crypto/secrets";
import { fetchPsi, type PsiResult } from "@/lib/adapters/psi";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import { collectRankMath } from "./collect";
import type { SeoRepo } from "./repo";
import type { PsiPayload, SourceResult } from "./types";

export interface SeoScanDeps {
  sites: SitesRepo;
  seo: SeoRepo;
  mcp: McpFactory;
  fetchImpl?: typeof fetch;
}

async function collectPsi(url: string, fetchImpl?: typeof fetch): Promise<SourceResult<PsiPayload>> {
  const run = async (strategy: "mobile" | "desktop") => {
    try {
      return { value: await fetchPsi(url, strategy, fetchImpl ?? fetch), error: null as string | null };
    } catch (e) {
      return { value: null as PsiResult | null, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const [mobile, desktop] = await Promise.all([run("mobile"), run("desktop")]);
  if (!mobile.value && !desktop.value) {
    return { source: "psi", status: "error", reason: mobile.error ?? desktop.error ?? "PageSpeed Insights failed" };
  }
  return {
    source: "psi",
    status: "ok",
    ...(mobile.error || desktop.error
      ? { reason: [mobile.error, desktop.error].filter(Boolean).join(" | ") }
      : {}),
    data: { mobile: mobile.value, desktop: desktop.value, url },
  };
}

export async function seoScan(
  deps: SeoScanDeps, siteId: string,
): Promise<{ takenAt: string; results: SourceResult[] }> {
  const site = await deps.sites.getSite(siteId);
  if (!site) throw new Error(`Site not found: ${siteId}`);

  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) throw new Error(`Credentials missing for site: ${siteId}`);

  const client = await deps.mcp({
    endpoint: creds.mcp_endpoint,
    username: creds.wp_username,
    appPassword: await decryptSecret(creds.app_password_encrypted),
  });
  let results: SourceResult[];
  try {
    // Discover abilities live: the stored capability map is written at connect
    // time, so a site that gained Rank Math afterwards would otherwise report
    // every source as "skipped" forever. Fall back to the stored list.
    let abilities = site.capabilities?.abilities ?? [];
    try {
      const discovered = await client.discoverAbilities();
      if (discovered.abilities.length > 0) abilities = discovered.abilities.map((a) => a.name);
    } catch { /* keep the stored capability list */ }
    results = await collectRankMath(client, abilities);
  } finally {
    await client.close();
  }

  results.push(await collectPsi(site.url, deps.fetchImpl));

  const takenAt = new Date().toISOString();
  await deps.seo.insertSnapshots(siteId, takenAt, results);
  return { takenAt, results };
}
