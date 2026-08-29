import { describe, it, expect } from "vitest";
import {
  partitionMcpServers,
  deriveSiteUrl,
  normalizeSiteUrl,
  findDuplicate,
  deriveSiteMeta,
  maskUsername,
} from "../scripts/lib/novamira-import";

// Pure-logic coverage for scripts/import-novamira-sites.ts. Deliberately
// never touches the real Claude Desktop config file or the network --
// every fixture below is inline, matching the shape of the real config's
// mcpServers entries without reading it.

describe("partitionMcpServers", () => {
  it("treats an entry with all three WP_API_* keys as a WordPress candidate", () => {
    const { candidates, skipped } = partitionMcpServers({
      "novamira-example-com": {
        env: { WP_API_URL: "https://example.com/wp-json/mcp/novamira", WP_API_USERNAME: "OCS", WP_API_PASSWORD: "secret" },
      },
    });
    expect(skipped).toEqual([]);
    expect(candidates).toEqual([
      { serverName: "novamira-example-com", mcpApiUrl: "https://example.com/wp-json/mcp/novamira", username: "OCS", appPassword: "secret" },
    ]);
  });

  it("skips an entry missing any WP_API_* key, e.g. novamira-visual-onlinecre", () => {
    const { candidates, skipped } = partitionMcpServers({
      "novamira-visual-onlinecre": {
        env: { NOVAMIRA_VISUAL_WORKSPACE_URL: "https://onlinecreativesolutions.com/cherrybus/wp-admin/admin-post.php?action=novamira-visual" },
      },
    });
    expect(candidates).toEqual([]);
    expect(skipped).toEqual([
      { serverName: "novamira-visual-onlinecre", reason: expect.stringContaining("not a WordPress site") },
    ]);
  });

  it("skips an entry missing just one of the three keys", () => {
    const { candidates, skipped } = partitionMcpServers({
      "partial": { env: { WP_API_URL: "https://example.com/wp-json/mcp/novamira", WP_API_USERNAME: "OCS" } },
    });
    expect(candidates).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it("skips an entry with no env at all", () => {
    const { candidates, skipped } = partitionMcpServers({ "no-env": {} });
    expect(candidates).toEqual([]);
    expect(skipped).toHaveLength(1);
  });
});

describe("deriveSiteUrl", () => {
  it("strips exactly the mcpEndpointFor suffix", () => {
    expect(deriveSiteUrl("https://azaleabaguio.com/wp-json/mcp/novamira")).toEqual({
      ok: true,
      url: "https://azaleabaguio.com",
    });
  });

  it("keeps a subdirectory install's path as part of the site URL", () => {
    expect(deriveSiteUrl("https://azaleabaguio.com/staging2-baguio/wp-json/mcp/novamira")).toEqual({
      ok: true,
      url: "https://azaleabaguio.com/staging2-baguio",
    });
    expect(deriveSiteUrl("https://onlinecreativesolutions.com/AralAbroad/wp-json/mcp/novamira")).toEqual({
      ok: true,
      url: "https://onlinecreativesolutions.com/AralAbroad",
    });
  });

  it("tolerates a trailing slash on the configured URL", () => {
    expect(deriveSiteUrl("https://example.com/wp-json/mcp/novamira/")).toEqual({
      ok: true,
      url: "https://example.com",
    });
  });

  it("reports and refuses to guess when the URL does not end in the MCP suffix", () => {
    const result = deriveSiteUrl("https://example.com/some/other/path");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not end in");
  });

  it("reports when there is no origin before the suffix", () => {
    const result = deriveSiteUrl("/wp-json/mcp/novamira");
    expect(result.ok).toBe(false);
  });
});

describe("normalizeSiteUrl / findDuplicate", () => {
  it("lowercases the host and strips trailing slashes", () => {
    expect(normalizeSiteUrl("https://Graceland.PH/")).toBe(normalizeSiteUrl("https://graceland.ph"));
  });

  it("finds the one true duplicate: graceland.ph", () => {
    const existing = ["https://graceland.ph", "https://elnidoguide.ph"];
    expect(findDuplicate("https://graceland.ph", existing)).toBe("https://graceland.ph");
  });

  it("treats a differently-cased host as the same site (duplicate)", () => {
    const existing = ["https://Graceland.ph"];
    expect(findDuplicate("https://graceland.ph/", existing)).toBe("https://Graceland.ph");
  });

  it("does not treat elnidoguide.ph and staging.elnidoguide.ph as duplicates", () => {
    const existing = ["https://elnidoguide.ph"];
    expect(findDuplicate("https://staging.elnidoguide.ph", existing)).toBeUndefined();
  });

  it("does not treat a shared host with different subdirectory paths as a duplicate", () => {
    const existing = ["https://onlinecreativesolutions.com/AralAbroad"];
    expect(findDuplicate("https://onlinecreativesolutions.com/cherrybus", existing)).toBeUndefined();
    expect(findDuplicate("https://onlinecreativesolutions.com", existing)).toBeUndefined();
  });

  it("returns undefined when there is no match", () => {
    expect(findDuplicate("https://newsite.com", ["https://graceland.ph"])).toBeUndefined();
  });
});

describe("deriveSiteMeta", () => {
  it("names a compound root-domain host from the override map", () => {
    expect(deriveSiteMeta("https://azaleabaguio.com")).toEqual({
      name: "Azalea Baguio", clientLabel: "Azalea Baguio", isStaging: false,
    });
    expect(deriveSiteMeta("https://cherrybuspalawan.ph")).toMatchObject({ name: "Cherry Bus Palawan", isStaging: false });
    expect(deriveSiteMeta("https://beachbus.ph")).toMatchObject({ name: "Beach Bus", isStaging: false });
    expect(deriveSiteMeta("https://elnidoguide.ph")).toMatchObject({ name: "El Nido Guide", isStaging: false });
    expect(deriveSiteMeta("https://onlinecreativesolutions.com")).toMatchObject({ name: "Online Creative Solutions", isStaging: false });
    expect(deriveSiteMeta("https://aralabroad.com")).toMatchObject({ name: "Aral Abroad", isStaging: false });
  });

  it("marks a staging2-suffixed subdirectory as staging, reusing the host's name when the subdirectory only restates it", () => {
    expect(deriveSiteMeta("https://azaleabaguio.com/staging2-baguio")).toEqual({
      name: "Azalea Baguio (Staging)", clientLabel: "Azalea Baguio (Staging)", isStaging: true,
    });
    expect(deriveSiteMeta("https://azaleaboracay.com/staging2")).toEqual({
      name: "Azalea Boracay (Staging)", clientLabel: "Azalea Boracay (Staging)", isStaging: true,
    });
  });

  it("marks any subdirectory install as staging even without the word 'staging', preferring the subdirectory's own brand", () => {
    expect(deriveSiteMeta("https://onlinecreativesolutions.com/AralAbroad")).toEqual({
      name: "Aral Abroad (Staging)", clientLabel: "Aral Abroad (Staging)", isStaging: true,
    });
    expect(deriveSiteMeta("https://onlinecreativesolutions.com/cherrybus")).toEqual({
      name: "Cherry Bus (Staging)", clientLabel: "Cherry Bus (Staging)", isStaging: true,
    });
  });

  it("never produces the same name for a production site and its staging counterpart", () => {
    const prod = deriveSiteMeta("https://azaleaboracay.com");
    const staging = deriveSiteMeta("https://azaleaboracay.com/staging2");
    expect(prod.name).not.toBe(staging.name);
    expect(staging.isStaging).toBe(true);
    expect(prod.isStaging).toBe(false);
  });
});

describe("maskUsername", () => {
  it("leaves usernames of 3 characters or fewer untouched", () => {
    expect(maskUsername("OCS")).toBe("OCS");
    expect(maskUsername("ab")).toBe("ab");
  });

  it("masks everything beyond the first 3 characters", () => {
    expect(maskUsername("Admin")).toBe("Adm**");
    expect(maskUsername("bhenks")).toBe("bhe***");
    expect(maskUsername("teamocsph@gmail.com")).toBe(`tea${"*".repeat("teamocsph@gmail.com".length - 3)}`);
  });

  it("never returns the original string when longer than 3 characters", () => {
    expect(maskUsername("teamocsph@gmail.com")).not.toBe("teamocsph@gmail.com");
  });
});
