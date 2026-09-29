import { describe, expect, it } from "vitest";
import { diffInventories } from "@/services/sites/drift";
import type { InventoryPayload, PluginInfo, ThemeInfo } from "@/services/inventory/types";

function plugin(file: string, version: string, status = "active", title?: string): PluginInfo {
  return {
    file, name: file.split("/")[0], title, version, status, update: "none",
  };
}

function theme(name: string, version: string, status = "inactive"): ThemeInfo {
  return { name, template: name, version, status, update: "none" };
}

function inventory(overrides: Partial<InventoryPayload> = {}): InventoryPayload {
  return {
    collected_at: "2026-09-29T00:00:00Z",
    wp_version: "6.6.2",
    php_version: "8.2.10",
    admin_url: "https://example.com/wp-admin/",
    core_update: null,
    plugins: [],
    themes: [],
    ...overrides,
  };
}

describe("diffInventories", () => {
  it("reports in sync when both sides carry the same inventory", () => {
    const inv = inventory({
      plugins: [plugin("akismet/akismet.php", "5.3")],
      themes: [theme("astra", "4.8.1", "active")],
    });
    const drift = diffInventories(inv, structuredClone(inv));

    expect(drift.inSync).toBe(true);
    expect(drift.core).toBeNull();
    expect(drift.php).toBeNull();
    expect(drift.plugins).toEqual({
      onlyOnStaging: [], onlyOnProduction: [], versionDiffers: [], activeDiffers: [],
    });
  });

  it("reports a WordPress core and PHP version difference", () => {
    const drift = diffInventories(
      inventory({ wp_version: "6.7", php_version: "8.3.1" }),
      inventory({ wp_version: "6.6.2", php_version: "8.2.10" }),
    );

    expect(drift.inSync).toBe(false);
    expect(drift.core).toEqual({ staging: "6.7", production: "6.6.2" });
    expect(drift.php).toEqual({ staging: "8.3.1", production: "8.2.10" });
  });

  it("splits plugins into only-on-staging, only-on-production, version and active drift", () => {
    const staging = inventory({
      plugins: [
        plugin("akismet/akismet.php", "5.3", "active", "Akismet"),
        plugin("query-monitor/query-monitor.php", "3.16", "active"),
        plugin("seo/seo.php", "22.0", "active"),
        plugin("forms/forms.php", "2.1", "inactive"),
      ],
    });
    const production = inventory({
      plugins: [
        plugin("akismet/akismet.php", "5.3", "active", "Akismet"),
        plugin("seo/seo.php", "21.9", "active"),
        plugin("forms/forms.php", "2.1", "active"),
        plugin("cache/cache.php", "1.0", "active", "Cache"),
      ],
    });

    const drift = diffInventories(staging, production);

    expect(drift.inSync).toBe(false);
    expect(drift.plugins.onlyOnStaging).toEqual([
      { key: "query-monitor/query-monitor.php", label: "query-monitor", version: "3.16", active: true },
    ]);
    expect(drift.plugins.onlyOnProduction).toEqual([
      { key: "cache/cache.php", label: "Cache", version: "1.0", active: true },
    ]);
    expect(drift.plugins.versionDiffers).toEqual([
      { key: "seo/seo.php", label: "seo", staging: "22.0", production: "21.9" },
    ]);
    expect(drift.plugins.activeDiffers).toEqual([
      { key: "forms/forms.php", label: "forms", stagingActive: false, productionActive: true },
    ]);
  });

  it("diffs themes by stylesheet, including which one is active", () => {
    const drift = diffInventories(
      inventory({ themes: [theme("astra", "4.8.1", "active"), theme("twentytwentyfour", "1.2")] }),
      inventory({ themes: [theme("astra", "4.8.0", "inactive"), theme("twentytwentyfour", "1.2", "active")] }),
    );

    expect(drift.themes.versionDiffers).toEqual([
      { key: "astra", label: "astra", staging: "4.8.1", production: "4.8.0" },
    ]);
    expect(drift.themes.activeDiffers).toEqual([
      { key: "astra", label: "astra", stagingActive: true, productionActive: false },
      { key: "twentytwentyfour", label: "twentytwentyfour", stagingActive: false, productionActive: true },
    ]);
    expect(drift.themes.onlyOnStaging).toEqual([]);
    expect(drift.themes.onlyOnProduction).toEqual([]);
  });

  it("sorts every list by label so the card reads the same on every render", () => {
    const drift = diffInventories(
      inventory({ plugins: [plugin("zeta/zeta.php", "1"), plugin("alpha/alpha.php", "1")] }),
      inventory(),
    );
    expect(drift.plugins.onlyOnStaging.map((p) => p.label)).toEqual(["alpha", "zeta"]);
  });

  it("counts a plugin that is both a different version and differently active in both lists", () => {
    const drift = diffInventories(
      inventory({ plugins: [plugin("a/a.php", "2", "active")] }),
      inventory({ plugins: [plugin("a/a.php", "1", "inactive")] }),
    );
    expect(drift.plugins.versionDiffers).toHaveLength(1);
    expect(drift.plugins.activeDiffers).toHaveLength(1);
  });

  it("tolerates a snapshot missing the plugin or theme arrays", () => {
    const broken = { ...inventory(), plugins: undefined, themes: undefined } as unknown as InventoryPayload;
    const drift = diffInventories(broken, inventory({ plugins: [plugin("a/a.php", "1")] }));
    expect(drift.plugins.onlyOnProduction).toHaveLength(1);
    expect(drift.themes.onlyOnStaging).toEqual([]);
  });
});
