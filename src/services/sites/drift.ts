import type { InventoryPayload, PluginInfo, ThemeInfo } from "@/services/inventory/types";

/**
 * Drift between a staging copy and the production site it was taken from
 * (0026_site_production_pair.sql).
 *
 * Pure: two inventory snapshots in, a description of every difference out.
 * The caller decides what "no snapshot" means -- this function is never
 * handed a missing side, because "we have not looked" and "they match" are
 * different answers and collapsing them is how a stale staging copy reads as
 * "In sync" (PRODUCT.md, principle 4).
 */

export interface VersionPair { staging: string; production: string }

export interface DriftItem {
  /** Plugin basename or theme stylesheet -- the identity WordPress uses. */
  key: string;
  label: string;
  version: string;
  active: boolean;
}

export interface VersionDrift { key: string; label: string; staging: string; production: string }
export interface ActiveDrift { key: string; label: string; stagingActive: boolean; productionActive: boolean }

export interface ComponentDrift {
  onlyOnStaging: DriftItem[];
  onlyOnProduction: DriftItem[];
  versionDiffers: VersionDrift[];
  activeDiffers: ActiveDrift[];
}

export interface InventoryDrift {
  /** Null when the two sides match. */
  core: VersionPair | null;
  php: VersionPair | null;
  plugins: ComponentDrift;
  themes: ComponentDrift;
  inSync: boolean;
}

interface Normalised { key: string; label: string; version: string; active: boolean }

function fromPlugin(p: PluginInfo): Normalised {
  return { key: p.file, label: p.title || p.name || p.file, version: p.version, active: p.status === "active" };
}

function fromTheme(t: ThemeInfo): Normalised {
  return { key: t.name, label: t.title || t.name, version: t.version, active: t.status === "active" };
}

const byLabel = (a: { label: string; key: string }, b: { label: string; key: string }) =>
  a.label.localeCompare(b.label) || a.key.localeCompare(b.key);

function diffComponents(staging: Normalised[], production: Normalised[]): ComponentDrift {
  const prodByKey = new Map(production.map((p) => [p.key, p]));
  const stagingKeys = new Set(staging.map((s) => s.key));
  const out: ComponentDrift = { onlyOnStaging: [], onlyOnProduction: [], versionDiffers: [], activeDiffers: [] };

  for (const s of staging) {
    const p = prodByKey.get(s.key);
    if (!p) {
      out.onlyOnStaging.push({ key: s.key, label: s.label, version: s.version, active: s.active });
      continue;
    }
    // Labelled from staging: it is the page the reader is on.
    if (s.version !== p.version) {
      out.versionDiffers.push({ key: s.key, label: s.label, staging: s.version, production: p.version });
    }
    if (s.active !== p.active) {
      out.activeDiffers.push({ key: s.key, label: s.label, stagingActive: s.active, productionActive: p.active });
    }
  }
  for (const p of production) {
    if (!stagingKeys.has(p.key)) {
      out.onlyOnProduction.push({ key: p.key, label: p.label, version: p.version, active: p.active });
    }
  }

  out.onlyOnStaging.sort(byLabel);
  out.onlyOnProduction.sort(byLabel);
  out.versionDiffers.sort(byLabel);
  out.activeDiffers.sort(byLabel);
  return out;
}

function isEmpty(c: ComponentDrift): boolean {
  return c.onlyOnStaging.length === 0 && c.onlyOnProduction.length === 0
    && c.versionDiffers.length === 0 && c.activeDiffers.length === 0;
}

function versionPair(staging: string, production: string): VersionPair | null {
  return staging === production ? null : { staging, production };
}

export function diffInventories(staging: InventoryPayload, production: InventoryPayload): InventoryDrift {
  // `?? []`: a snapshot is JSON from a live site, and a malformed one must
  // not take down the whole site page.
  const plugins = diffComponents(
    (staging.plugins ?? []).map(fromPlugin), (production.plugins ?? []).map(fromPlugin),
  );
  const themes = diffComponents(
    (staging.themes ?? []).map(fromTheme), (production.themes ?? []).map(fromTheme),
  );
  const core = versionPair(staging.wp_version, production.wp_version);
  const php = versionPair(staging.php_version, production.php_version);
  return {
    core, php, plugins, themes,
    inSync: core === null && php === null && isEmpty(plugins) && isEmpty(themes),
  };
}

/** Total number of differences, for a one-line summary. */
export function driftCount(d: InventoryDrift): number {
  const n = (c: ComponentDrift) =>
    c.onlyOnStaging.length + c.onlyOnProduction.length + c.versionDiffers.length + c.activeDiffers.length;
  return (d.core ? 1 : 0) + (d.php ? 1 : 0) + n(d.plugins) + n(d.themes);
}
