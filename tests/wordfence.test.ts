import { describe, it, expect } from "vitest";
import { parseWordfenceFeed, fetchWordfenceFeed } from "@/lib/adapters/vulnfeed/wordfence";

// Shape per Wordfence Intelligence vulnerability feed docs (v2/v3 record format).
const SAMPLE = {
  "11111111-aaaa-bbbb-cccc-000000000001": {
    id: "11111111-aaaa-bbbb-cccc-000000000001",
    title: "Akismet < 5.4 - XSS",
    software: [
      {
        type: "plugin", slug: "akismet",
        affected_versions: {
          "* - 5.3.9": { from_version: "*", from_inclusive: true, to_version: "5.3.9", to_inclusive: true },
        },
        patched: true, patched_versions: ["5.4"],
      },
    ],
    cvss: { score: 6.4, rating: "Medium" },
    cve: "CVE-2026-0001",
  },
  "11111111-aaaa-bbbb-cccc-000000000002": {
    id: "11111111-aaaa-bbbb-cccc-000000000002",
    title: "WordPress Core - RCE",
    software: [
      {
        type: "core", slug: "wordpress",
        affected_versions: {
          "6.0 - 6.4.2": { from_version: "6.0", from_inclusive: true, to_version: "6.4.2", to_inclusive: true },
        },
        patched: true, patched_versions: ["6.4.3"],
      },
    ],
    cvss: { score: 9.8, rating: "Critical" },
    cve: null,
  },
  "malformed": { id: "malformed" }, // no software array — must be skipped
};

describe("parseWordfenceFeed", () => {
  it("flattens vuln records to one entry per software", () => {
    const entries = parseWordfenceFeed(SAMPLE);
    expect(entries).toHaveLength(2);
    const akismet = entries.find((e) => e.software_slug === "akismet")!;
    expect(akismet).toMatchObject({
      id: "11111111-aaaa-bbbb-cccc-000000000001:plugin:akismet",
      software_type: "plugin", cve: "CVE-2026-0001", cvss: 6.4, fixed_in: "5.4",
    });
    expect(akismet.affected_versions[0]).toMatchObject({ from_version: "*", to_version: "5.3.9" });
    const core = entries.find((e) => e.software_type === "core")!;
    expect(core.cvss).toBe(9.8);
    expect(core.cve).toBeNull();
  });
  it("returns [] for garbage input", () => {
    expect(parseWordfenceFeed(null)).toEqual([]);
    expect(parseWordfenceFeed("nope")).toEqual([]);
  });
});

describe("fetchWordfenceFeed", () => {
  it("sends Bearer auth and parses the body", async () => {
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain("/v3/vulnerabilities/scanner");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }) as typeof fetch;
    const entries = await fetchWordfenceFeed("test-key", fetchImpl);
    expect(entries).toHaveLength(2);
  });
  it("throws with the HTTP status on auth failure", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(fetchWordfenceFeed("bad", fetchImpl)).rejects.toThrow(/401/);
  });
});
