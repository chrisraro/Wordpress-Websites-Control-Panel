import { describe, it, expect } from "vitest";
import {
  DIRECTORY_PAGE_SIZE, directoryHref, parseDirectoryQuery, queryDirectory, resolvePairs, type DirectoryFields,
} from "@/services/sites/directory";
import { fleetOverview, liveness } from "@/services/sites/overview";
import { liveFrameUrl, sitePreviewUrl } from "@/services/sites/preview";
import { siteAttention } from "@/services/sites/portfolio";

function entry(name: string, over: Partial<DirectoryFields> = {}): DirectoryFields {
  return {
    id: name, name, url: `https://${name.toLowerCase().replace(/\s+/g, "")}.ph`, clientLabel: null,
    env: "production", severity: "ok", status: "connected", ...over,
  };
}
const id = (f: DirectoryFields) => f;
const names = (r: { items: DirectoryFields[] }) => r.items.map((f) => f.name);

describe("parseDirectoryQuery", () => {
  it("defaults to every site, attention-first, page 1", () => {
    expect(parseDirectoryQuery({})).toEqual({ q: "", env: "all", sort: "name", page: 1 });
  });

  it("accepts the old tab link (?env=staging) and 'production' as live", () => {
    expect(parseDirectoryQuery({ env: "staging" }).env).toBe("staging");
    expect(parseDirectoryQuery({ env: "production" }).env).toBe("live");
    expect(parseDirectoryQuery({ env: "live" }).env).toBe("live");
  });

  it("falls back on unknown values instead of trusting the URL", () => {
    const q = parseDirectoryQuery({ env: "prod'--", sort: "__proto__", page: "-3" });
    expect(q).toMatchObject({ env: "all", sort: "name", page: 1 });
  });

  it("trims and caps the search text", () => {
    expect(parseDirectoryQuery({ q: "  naga  " }).q).toBe("naga");
    expect(parseDirectoryQuery({ q: "x".repeat(500) }).q).toHaveLength(100);
  });
});

describe("queryDirectory", () => {
  const rows = [
    entry("Umahotel"),
    entry("Graceland", { severity: "critical", grade: "F" }),
    entry("Azalea Baguio", { env: "staging", updates: 4, clientLabel: "Azalea Group" }),
    entry("Naga City Guide", { severity: "warn", grade: "D", uptime24h: 91.2 }),
    entry("Beach Bus", { grade: "A", updates: 1, seo: 88, uptime24h: 100 }),
  ];

  it("searches name, URL and client label, case-insensitively", () => {
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ q: "AZALEA group" })))).toEqual(["Azalea Baguio"]);
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ q: "nothing-like-this" })))).toEqual([]);
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ q: "azalea" })))).toEqual(["Azalea Baguio"]);
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ q: "group" })))).toEqual(["Azalea Baguio"]);
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ q: "beachbus.ph" })))).toEqual(["Beach Bus"]);
  });

  it("filters by environment", () => {
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ env: "staging" })))).toEqual(["Azalea Baguio"]);
    expect(queryDirectory(rows, id, parseDirectoryQuery({ env: "live" })).total).toBe(4);
  });

  it("sorts attention-first on request, then by name", () => {
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ sort: "attention" })))).toEqual(
      ["Graceland", "Naga City Guide", "Azalea Baguio", "Beach Bus", "Umahotel"],
    );
  });

  it("sorts live-first and staging-first", () => {
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ sort: "staging" })))[0]).toBe("Azalea Baguio");
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ sort: "live" }))).at(-1)).toBe("Azalea Baguio");
  });

  it("sorts by worst grade, most updates and lowest uptime, unmeasured last", () => {
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ sort: "grade" }))).slice(0, 3))
      .toEqual(["Graceland", "Naga City Guide", "Beach Bus"]);
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ sort: "updates" }))).slice(0, 2))
      .toEqual(["Azalea Baguio", "Beach Bus"]);
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ sort: "uptime" }))).slice(0, 2))
      .toEqual(["Naga City Guide", "Beach Bus"]);
  });

  it("pages nine at a time and clamps a page past the end", () => {
    const many = Array.from({ length: 23 }, (_, i) => entry(`Site ${String(i).padStart(2, "0")}`));
    const p1 = queryDirectory(many, id, parseDirectoryQuery({ sort: "name" }));
    expect(p1.items).toHaveLength(DIRECTORY_PAGE_SIZE);
    expect(p1).toMatchObject({ page: 1, totalPages: 3, total: 23 });
    const last = queryDirectory(many, id, parseDirectoryQuery({ sort: "name", page: "9" }));
    expect(last.page).toBe(3);
    expect(names(last)).toEqual(["Site 18", "Site 19", "Site 20", "Site 21", "Site 22"]);
  });
});

describe("directoryHref", () => {
  it("keeps the query, omits defaults and page 1, and lands on the directory", () => {
    const q = parseDirectoryQuery({ q: "naga", env: "staging", sort: "name", page: "2" });
    expect(directoryHref(q, {})).toBe("/dashboard?q=naga&env=staging&page=2#sites");
    expect(directoryHref(q, { page: 1 })).toBe("/dashboard?q=naga&env=staging#sites");
    expect(directoryHref(parseDirectoryQuery({}), {})).toBe("/dashboard#sites");
  });
});

describe("fleetOverview", () => {
  it("summarises health, uptime, grades, updates, SEO and SSL across the fleet", () => {
    const o = fleetOverview([
      entry("A", { severity: "critical", grade: "F", up: false, uptime24h: 50, sslDays: 5 }),
      entry("B", { grade: "A", updates: 3, seo: 80, up: true, uptime24h: 100, sslDays: 60 }),
      entry("C", { env: "staging", updates: 2, seo: 60, up: true, uptime24h: 100 }),
      entry("D", { status: "disabled" }),
    ]);
    expect(o).toMatchObject({
      total: 4, live: 3, staging: 1, disabled: 1,
      critical: 1, warn: 0, healthy: 3,
      up: 2, down: 1, unmeasured: 1,
      updatesPending: 5, sitesWithUpdates: 2,
      averageSeo: 70, sslExpiring: 1, sslMeasured: 2,
    });
    expect(o.averageUptime).toBeCloseTo(83.3, 1);
    expect(o.grades).toEqual({ A: 1, B: 0, C: 0, D: 0, F: 1, none: 2 });
  });

  it("reports null averages when nothing has been measured", () => {
    const o = fleetOverview([entry("A")]);
    expect(o.averageUptime).toBeNull();
    expect(o.averageSeo).toBeNull();
  });
});

describe("sitePreviewUrl", () => {
  it("builds an encoded screenshot URL for http(s) sites", () => {
    expect(sitePreviewUrl("https://graceland.ph/")).toBe(
      "https://s.wordpress.com/mshots/v1/https%3A%2F%2Fgraceland.ph%2F?w=640&h=400",
    );
  });

  it("refuses anything that is not http(s)", () => {
    expect(sitePreviewUrl("javascript:alert(1)")).toBeNull();
    expect(sitePreviewUrl("not a url")).toBeNull();
  });
});

describe("siteAttention with uptime", () => {
  it("makes a site whose latest check failed critical, worst reason first", () => {
    const a = siteAttention({ status: "connected", grade: "D", up: false });
    expect(a.severity).toBe("critical");
    expect(a.reasons[0]).toMatch(/not responding/i);
  });

  it("ignores an unmeasured site and a disabled one", () => {
    expect(siteAttention({ status: "connected", up: null }).severity).toBe("ok");
    expect(siteAttention({ status: "disabled", up: false }).severity).toBe("ok");
  });
});

describe("liveness (latest uptime checks → up/down)", () => {
  const NOW = Date.parse("2026-09-29T12:00:00Z");
  const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

  it("is up when the latest recent check passed", () => {
    expect(liveness({ latestOk: true, failStreak: 0, latestAt: at(3) }, NOW)).toEqual({ up: true, unconfirmed: false });
  });

  it("needs two consecutive failures before calling a site down", () => {
    expect(liveness({ latestOk: false, failStreak: 1, latestAt: at(3) }, NOW)).toEqual({ up: null, unconfirmed: true });
    expect(liveness({ latestOk: false, failStreak: 2, latestAt: at(3) }, NOW)).toEqual({ up: false, unconfirmed: false });
  });

  it("treats a stale or missing reading as unknown, never as down", () => {
    expect(liveness({ latestOk: false, failStreak: 5, latestAt: at(120) }, NOW)).toEqual({ up: null, unconfirmed: false });
    expect(liveness(null, NOW)).toEqual({ up: null, unconfirmed: false });
    expect(liveness({ latestOk: null }, NOW)).toEqual({ up: null, unconfirmed: false });
  });
});

describe("search tolerates a pasted URL", () => {
  it("strips the scheme from the query too", () => {
    const r = queryDirectory([entry("Beach Bus")], id, parseDirectoryQuery({ q: "https://beachbus.ph" }));
    expect(r.total).toBe(1);
  });
});

describe("sitePreviewUrl for staging", () => {
  it("is not built for staging copies (their URLs stay private)", () => {
    expect(sitePreviewUrl("https://staging.graceland.ph/", "staging")).toBeNull();
    expect(sitePreviewUrl("https://graceland.ph/", "production")).not.toBeNull();
  });
});

describe("liveFrameUrl (when a card shows the live site)", () => {
  it("only for https homepages the uptime check found frameable", () => {
    expect(liveFrameUrl("https://graceland.ph/", true)).toBe("https://graceland.ph/");
    expect(liveFrameUrl("https://graceland.ph/", false)).toBeNull();
    expect(liveFrameUrl("https://graceland.ph/", null)).toBeNull();
    // An http page in an https panel is blocked as mixed content anyway.
    expect(liveFrameUrl("http://upcatreviewplus.com/", true)).toBeNull();
    expect(liveFrameUrl("javascript:alert(1)", true)).toBeNull();
  });
});

describe("staging copies sit beside their live site (default A–Z)", () => {
  const live = (name: string, url: string, over: Partial<DirectoryFields> = {}) =>
    entry(name, { id: name, url, ...over });
  const rows = [
    live("Umahotel", "https://umahotel.ph/"),
    live("Graceland", "https://graceland.ph/"),
    live("Zeta Staging Copy", "https://staging.graceland.ph/", { env: "staging" }),
    live("Azalea Baguio", "https://azaleabaguio.com/"),
    live("Acad1 Stage", "https://acad1.ph/stage", { env: "staging", pairOf: "Umahotel" }),
    live("Beach Bus Staging", "https://beachbus-dev.example.com/", { env: "staging" }),
    live("Beach Bus", "https://beachbus.ph/"),
  ];

  it("groups by the live site's name: explicit pair, then host, then name", () => {
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({})))).toEqual([
      "Azalea Baguio",
      "Beach Bus", "Beach Bus Staging", // by name ("Staging" stripped)
      "Graceland", "Zeta Staging Copy", // by host (staging.graceland.ph)
      "Umahotel", "Acad1 Stage", // explicit pair wins over its own name
    ]);
  });

  it("falls back to its own name when its live site is filtered out", () => {
    expect(names(queryDirectory(rows, id, parseDirectoryQuery({ env: "staging" })))).toEqual(
      ["Acad1 Stage", "Beach Bus Staging", "Zeta Staging Copy"],
    );
  });

  it("resolvePairs never pairs a live site, or a staging site with another staging site", () => {
    const pairs = resolvePairs(rows);
    expect(pairs.get("Zeta Staging Copy")).toBe("Graceland");
    expect(pairs.get("Beach Bus Staging")).toBe("Beach Bus");
    expect(pairs.get("Acad1 Stage")).toBe("Umahotel");
    expect(pairs.has("Graceland")).toBe(false);
  });
});
