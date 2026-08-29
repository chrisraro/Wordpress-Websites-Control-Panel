import { describe, it, expect } from "vitest";
import { computeGrade, severityFromCvss } from "@/services/security/types";
import { matchInventory } from "@/services/security/vulns";
import type { FeedEntry } from "@/lib/adapters/vulnfeed/wordfence";
import type { InventoryPayload } from "@/services/inventory/types";

describe("severityFromCvss", () => {
  it("maps CVSS bands", () => {
    expect(severityFromCvss(9.8)).toBe("critical");
    expect(severityFromCvss(7.0)).toBe("high");
    expect(severityFromCvss(5.0)).toBe("medium");
    expect(severityFromCvss(2.1)).toBe("low");
    expect(severityFromCvss(0)).toBeNull();
    expect(severityFromCvss(null)).toBeNull();
  });
});

describe("computeGrade", () => {
  it("gives A with a clean slate", () => {
    expect(computeGrade({ vulnSeverities: [], checks: [], uptime24h: 100 }))
      .toEqual({ grade: "A", score: 100 });
  });
  it("applies exact weights", () => {
    const g = computeGrade({
      vulnSeverities: ["critical", "low"],                        // -30 -5
      checks: [
        { check_id: "wp_debug", result: "fail" },                 // -5
        { check_id: "core_checksums", result: "fail" },           // -15
        { check_id: "xmlrpc_enabled", result: "warn" },           // -2
        { check_id: "https_urls", result: "pass" },               // 0
      ],
      uptime24h: 97.5,                                            // -5
    });
    expect(g.score).toBe(100 - 30 - 5 - 5 - 15 - 2 - 5);
    expect(g.grade).toBe("F"); // 38 < 50
  });
  it("clamps at zero and ignores null uptime", () => {
    const g = computeGrade({
      vulnSeverities: Array(5).fill("critical"),
      checks: [],
      uptime24h: null,
    });
    expect(g).toEqual({ grade: "F", score: 0 });
  });
  it("bands correctly", () => {
    expect(computeGrade({ vulnSeverities: [null, null], checks: [], uptime24h: null }).grade).toBe("A"); // 90
    expect(computeGrade({ vulnSeverities: ["medium", "medium"], checks: [], uptime24h: null }).grade).toBe("B"); // 80
    expect(computeGrade({ vulnSeverities: ["high", "medium"], checks: [], uptime24h: null }).grade).toBe("C"); // 70
    expect(computeGrade({ vulnSeverities: ["critical", "high"], checks: [], uptime24h: null }).grade).toBe("D"); // 50
  });
});

const FEED: FeedEntry[] = [
  {
    id: "v1:plugin:akismet", title: "Akismet XSS", cve: null, cvss: 6.4,
    software_type: "plugin", software_slug: "akismet",
    affected_versions: [{ from_version: "*", from_inclusive: true, to_version: "5.3.9", to_inclusive: true }],
    fixed_in: "5.4",
  },
  {
    id: "v2:core:wordpress", title: "Core RCE", cve: null, cvss: 9.8,
    software_type: "core", software_slug: "wordpress",
    affected_versions: [{ from_version: "6.0", from_inclusive: true, to_version: "6.4.2", to_inclusive: true }],
    fixed_in: "6.4.3",
  },
  {
    id: "v3:theme:generatepress", title: "GP LFI", cve: null, cvss: 7.5,
    software_type: "theme", software_slug: "generatepress",
    affected_versions: [{ from_version: "*", from_inclusive: true, to_version: "3.0", to_inclusive: false }],
    fixed_in: "3.0",
  },
];

function inv(over: Partial<InventoryPayload> = {}): InventoryPayload {
  return {
    collected_at: "2026-08-28T00:00:00Z", wp_version: "6.4.1", php_version: "8.2",
    admin_url: "https://example.com/wp-admin/",
    core_update: null,
    plugins: [{ file: "akismet/akismet.php", name: "akismet", version: "5.3", status: "active", update: "available", update_version: "5.4" }],
    themes: [{ name: "generatepress", template: "generatepress", version: "3.4", status: "active", update: "none", update_version: null }],
    ...over,
  };
}

describe("matchInventory", () => {
  it("matches vulnerable plugin versions and core", () => {
    const m = matchInventory(FEED, inv());
    expect(m).toHaveLength(2);
    expect(m.find((x) => x.component === "plugin:akismet")).toMatchObject({
      feed_id: "v1:plugin:akismet", installed_version: "5.3", severity: "medium",
    });
    expect(m.find((x) => x.component === "core")).toMatchObject({ severity: "critical", installed_version: "6.4.1" });
  });
  it("does not match patched versions", () => {
    const m = matchInventory(FEED, inv({
      wp_version: "6.4.3",
      plugins: [{ file: "akismet/akismet.php", name: "akismet", version: "5.4", status: "active", update: "none", update_version: null }],
      themes: [{ name: "generatepress", template: "generatepress", version: "3.0", status: "active", update: "none", update_version: null }],
    }));
    expect(m).toEqual([]);
  });
});
