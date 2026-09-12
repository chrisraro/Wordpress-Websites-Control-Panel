import { describe, it, expect } from "vitest";
import { planFleetPluginUpdate, type FleetPlanDeps } from "@/services/manage/fleet";
import type { SiteRow, SiteEnvironment } from "@/services/sites/types";
import type { Viewer } from "@/lib/authz/decide";
import type { SitesDeps } from "@/services/sites/service";
import type { JobsRepo } from "@/services/jobs/repo";

/**
 * planFleetPluginUpdate is the shared eligibility logic behind
 * `update_all_plugins_fleet` (src/mcp/tools/fleet.ts) and mirrors
 * updateAllPluginsAction's candidate filter
 * (src/app/(dashboard)/dashboard/actions.ts) -- see tests/dashboard-update-all-plugins.test.ts
 * for the equivalent coverage on that action. Every exclusion reason here
 * gets its own site id, so a regression in any one filter shows up as an
 * extra or missing id in exactly one bucket.
 */

function site(id: string, overrides: Partial<SiteRow> = {}): SiteRow {
  return {
    id,
    name: id,
    url: `https://${id}.example.com`,
    status: "connected",
    environment: "production",
    client_label: null,
    capabilities: { abilities: [] },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function snapshot(pluginUpdates: number) {
  return {
    taken_at: "2026-09-04T00:00:00Z",
    payload: {
      collected_at: "2026-09-04T00:00:00Z",
      wp_version: "6.8",
      php_version: "8.3",
      admin_url: "https://example.com/wp-admin/",
      core_update: null,
      plugins: Array.from({ length: pluginUpdates }, (_, i) => ({
        file: `p${i}/p${i}.php`, name: `p${i}`, version: "1.0", status: "active", update: "available",
      })),
      themes: [],
    },
  };
}

function makeDeps(opts: {
  sites: SiteRow[];
  snapshots: Record<string, ReturnType<typeof snapshot> | undefined>;
  pending?: Set<string>;
}): FleetPlanDeps {
  const sites = {
    repo: { listSites: async () => opts.sites },
  } as unknown as SitesDeps;
  const jobs = {
    pendingExists: async (_type: string, siteId: string | null) => (opts.pending ?? new Set()).has(siteId ?? ""),
  } as unknown as JobsRepo;
  return {
    sites,
    jobs,
    snapshots: { latestSnapshot: async (id: string) => opts.snapshots[id] ?? null },
  };
}

function viewer(grants: [string, "read" | "manage"][], permissions: string[] = ["wp_toolkit.manage"]): Viewer {
  return {
    id: "u1", email: null, role: "client",
    permissions: new Set(permissions as never[]),
    grants: new Map(grants),
  };
}

const PRODUCTION: SiteEnvironment = "production";

describe("planFleetPluginUpdate", () => {
  it("excludes a disabled site even with a manage grant and a plugin update waiting", async () => {
    const disabled = site("disabled1", { status: "disabled" });
    const deps = makeDeps({
      sites: [disabled],
      snapshots: { disabled1: snapshot(3) },
    });
    const v = viewer([["disabled1", "manage"]]);
    const plan = await planFleetPluginUpdate(deps, v, PRODUCTION);
    expect(plan.eligible).toEqual([]);
    expect(plan.alreadyQueued).toEqual([]);
    expect(plan.noUpdates).toEqual([]);
  });

  it("excludes a site in the other environment", async () => {
    const staging = site("staging1", { environment: "staging" });
    const deps = makeDeps({
      sites: [staging],
      snapshots: { staging1: snapshot(3) },
    });
    const v = viewer([["staging1", "manage"]]);
    const plan = await planFleetPluginUpdate(deps, v, PRODUCTION);
    expect(plan.eligible).toEqual([]);
    expect(plan.alreadyQueued).toEqual([]);
    expect(plan.noUpdates).toEqual([]);
  });

  it("excludes a site the viewer can only read, not manage", async () => {
    const readOnly = site("readonly1");
    const deps = makeDeps({
      sites: [readOnly],
      snapshots: { readonly1: snapshot(3) },
    });
    const v = viewer([["readonly1", "read"]]);
    const plan = await planFleetPluginUpdate(deps, v, PRODUCTION);
    expect(plan.eligible).toEqual([]);
    expect(plan.alreadyQueued).toEqual([]);
    expect(plan.noUpdates).toEqual([]);
  });

  it("excludes a site the viewer has no grant on at all", async () => {
    const ungranted = site("ungranted1");
    const deps = makeDeps({
      sites: [ungranted],
      snapshots: { ungranted1: snapshot(3) },
    });
    const v = viewer([]);
    const plan = await planFleetPluginUpdate(deps, v, PRODUCTION);
    expect(plan.eligible).toEqual([]);
  });

  it("buckets a manageable, in-environment site with nothing to update as noUpdates", async () => {
    const clean = site("clean1");
    const deps = makeDeps({
      sites: [clean],
      snapshots: { clean1: snapshot(0) },
    });
    const v = viewer([["clean1", "manage"]]);
    const plan = await planFleetPluginUpdate(deps, v, PRODUCTION);
    expect(plan.eligible).toEqual([]);
    expect(plan.noUpdates).toEqual([clean]);
    expect(plan.alreadyQueued).toEqual([]);
  });

  it("buckets a never-inventoried site (null snapshot) as noUpdates, not eligible", async () => {
    const neverScanned = site("neverscanned1");
    const deps = makeDeps({
      sites: [neverScanned],
      snapshots: {},
    });
    const v = viewer([["neverscanned1", "manage"]]);
    const plan = await planFleetPluginUpdate(deps, v, PRODUCTION);
    expect(plan.eligible).toEqual([]);
    expect(plan.noUpdates).toEqual([neverScanned]);
  });

  it("buckets a site with an update already queued as alreadyQueued, not eligible", async () => {
    const busy = site("busy1");
    const deps = makeDeps({
      sites: [busy],
      snapshots: { busy1: snapshot(2) },
      pending: new Set(["busy1"]),
    });
    const v = viewer([["busy1", "manage"]]);
    const plan = await planFleetPluginUpdate(deps, v, PRODUCTION);
    expect(plan.eligible).toEqual([]);
    expect(plan.alreadyQueued).toEqual([busy]);
    expect(plan.noUpdates).toEqual([]);
  });

  it("puts a manageable, in-environment, enabled site with a waiting update and no pending run in eligible", async () => {
    const good = site("good1");
    const deps = makeDeps({
      sites: [good],
      snapshots: { good1: snapshot(1) },
    });
    const v = viewer([["good1", "manage"]]);
    const plan = await planFleetPluginUpdate(deps, v, PRODUCTION);
    expect(plan.eligible).toEqual([good]);
  });

  it("sorts a mixed fleet into all three buckets in one call, never asking the wrong site for the wrong thing", async () => {
    const disabled = site("disabled2", { status: "disabled" });
    const staging = site("staging2", { environment: "staging" });
    const noGrant = site("nogrant2");
    const noUpdates = site("noupdates2");
    const alreadyQueued = site("queued2");
    const eligible = site("eligible2");

    const deps = makeDeps({
      sites: [disabled, staging, noGrant, noUpdates, alreadyQueued, eligible],
      snapshots: {
        disabled2: snapshot(5), staging2: snapshot(5),
        nogrant2: snapshot(5), noupdates2: snapshot(0),
        queued2: snapshot(3), eligible2: snapshot(2),
      },
      pending: new Set(["queued2"]),
    });
    const v = viewer([
      ["disabled2", "manage"], ["staging2", "manage"],
      ["noupdates2", "manage"], ["queued2", "manage"], ["eligible2", "manage"],
      // noGrant deliberately absent from the grants map.
    ]);

    const plan = await planFleetPluginUpdate(deps, v, PRODUCTION);
    expect(plan.eligible).toEqual([eligible]);
    expect(plan.alreadyQueued).toEqual([alreadyQueued]);
    expect(plan.noUpdates).toEqual([noUpdates]);
  });

  it("a viewer holding sites.view_all reaches a site with no explicit grant", async () => {
    const anySite = site("any1");
    const deps = makeDeps({
      sites: [anySite],
      snapshots: { any1: snapshot(1) },
    });
    const v = viewer([], ["wp_toolkit.manage", "sites.view_all"]);
    const plan = await planFleetPluginUpdate(deps, v, PRODUCTION);
    expect(plan.eligible).toEqual([anySite]);
  });
});
