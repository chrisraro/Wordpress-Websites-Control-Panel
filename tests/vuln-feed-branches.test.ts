import { describe, it, expect } from "vitest";
import { parseWordfenceFeed } from "@/lib/adapters/vulnfeed/wordfence";
import { matchInventory } from "@/services/security/vulns";
import type { InventoryPayload } from "@/services/inventory/types";

/**
 * One advisory, several maintained version branches.
 *
 * This shape is not hypothetical — it is miniorange-oauth-oidc-single-sign-on
 * and miniorange-saml-20-single-sign-on as they appear in Wordfence's live
 * production feed, and it broke the first real run of the feed refresh:
 * keying rows on uuid:type:slug produced duplicate primary keys and Postgres
 * rejected the whole chunk ("ON CONFLICT DO UPDATE command cannot affect row
 * a second time"), 4,000 rows in.
 */

/** Seven branches, ALL of them "everything up to <branch>.5.3" — so they
 *  overlap: a site on 18.0 is inside every one of them. */
const OVERLAPPING = {
  "51aa5531-e5b3-4c47-8d06-58eac6dd92fb": {
    id: "51aa5531-e5b3-4c47-8d06-58eac6dd92fb",
    title: "miniOrange OAuth — auth bypass",
    cve: "CVE-2026-0001",
    cvss: { score: 9.8 },
    software: [18, 40, 28, 48, 30, 38, 50].map((branch) => ({
      type: "plugin",
      slug: "miniorange-oauth-oidc-single-sign-on",
      affected_versions: {
        [`*-${branch}.5.3`]: {
          from_version: "*", from_inclusive: true,
          to_version: `${branch}.5.3`, to_inclusive: true,
        },
      },
      patched_versions: [`${branch}.5.4`],
    })),
  },
};

/** Three branches whose ranges do NOT overlap, each with its own fix. */
const DISJOINT = {
  "1adcc627-c371-452b-95b7-25c659117116": {
    id: "1adcc627-c371-452b-95b7-25c659117116",
    title: "miniOrange SAML — stored XSS",
    cve: "CVE-2026-0002",
    cvss: { score: 7.2 },
    software: [
      { branch: "16", fix: "16.0.8" },
      { branch: "12", fix: "12.1.0" },
      { branch: "20", fix: "20.0.7" },
    ].map(({ branch, fix }) => ({
      type: "plugin",
      slug: "miniorange-saml-20-single-sign-on",
      affected_versions: {
        [`[${branch}, ${fix})`]: {
          from_version: branch, from_inclusive: true,
          to_version: fix, to_inclusive: false,
        },
      },
      patched_versions: [fix],
    })),
  },
};

function inventory(slug: string, version: string): InventoryPayload {
  return {
    wp_version: "6.5",
    plugins: [{ name: slug, version, status: "active", update: "none" }],
    themes: [],
    core_update: false,
  } as unknown as InventoryPayload;
}

describe("parseWordfenceFeed — one advisory, several branches", () => {
  it("gives every branch its own id, so an upsert cannot collide", () => {
    const entries = parseWordfenceFeed(OVERLAPPING);
    expect(entries).toHaveLength(7);
    expect(new Set(entries.map((e) => e.id)).size).toBe(7);
  });

  it("leaves the first occurrence's id unchanged", () => {
    // replaceFeed upserts and never deletes, so changing the id scheme for
    // every row would orphan the whole table rather than update it. Only the
    // second and later occurrences may take a suffix.
    const entries = parseWordfenceFeed(OVERLAPPING);
    expect(entries[0].id).toBe(
      "51aa5531-e5b3-4c47-8d06-58eac6dd92fb:plugin:miniorange-oauth-oidc-single-sign-on",
    );
    expect(entries[1].id).toMatch(/#1$/);
  });

  it("keeps each branch's own fix rather than collapsing them", () => {
    const entries = parseWordfenceFeed(DISJOINT);
    expect(entries.map((e) => e.fixed_in).sort()).toEqual(["12.1.0", "16.0.8", "20.0.7"]);
  });
});

describe("matchInventory — overlapping branches", () => {
  it("reports one finding per advisory, not one per branch", () => {
    const entries = parseWordfenceFeed(OVERLAPPING);
    const matches = matchInventory(entries, inventory("miniorange-oauth-oidc-single-sign-on", "18.0"));
    expect(matches).toHaveLength(1);
  });

  it("points at the nearest fix above what is installed", () => {
    // A site on 18.0 must be told 18.5.4. Telling it 50.5.4 -- the last
    // matching branch -- would be advice to jump five major branches.
    const entries = parseWordfenceFeed(OVERLAPPING);
    const [m] = matchInventory(entries, inventory("miniorange-oauth-oidc-single-sign-on", "18.0"));
    const chosen = entries.find((e) => e.id === m.feed_id);
    expect(chosen?.fixed_in).toBe("18.5.4");
  });

  it("picks the branch's own fix when a later branch is installed", () => {
    const entries = parseWordfenceFeed(OVERLAPPING);
    const [m] = matchInventory(entries, inventory("miniorange-oauth-oidc-single-sign-on", "39.0"));
    const chosen = entries.find((e) => e.id === m.feed_id);
    expect(chosen?.fixed_in).toBe("40.5.4");
  });

  it("still carries the advisory's severity", () => {
    const entries = parseWordfenceFeed(OVERLAPPING);
    const [m] = matchInventory(entries, inventory("miniorange-oauth-oidc-single-sign-on", "18.0"));
    expect(m.severity).toBe("critical");
  });
});

describe("matchInventory — disjoint branches", () => {
  it("matches only the branch the site is actually on", () => {
    const entries = parseWordfenceFeed(DISJOINT);
    const [m] = matchInventory(entries, inventory("miniorange-saml-20-single-sign-on", "12.0.5"));
    const chosen = entries.find((e) => e.id === m.feed_id);
    expect(chosen?.fixed_in).toBe("12.1.0");
  });

  it("finds nothing for a site already on a fixed version", () => {
    const entries = parseWordfenceFeed(DISJOINT);
    expect(matchInventory(entries, inventory("miniorange-saml-20-single-sign-on", "20.0.7"))).toHaveLength(0);
  });
});

describe("matchInventory — a real fix beats no fix", () => {
  it("prefers the row that says what to upgrade to", () => {
    const feed = {
      "aaaaaaaa-0000-0000-0000-000000000000": {
        id: "aaaaaaaa-0000-0000-0000-000000000000",
        title: "Two branches, only one patched",
        cvss: { score: 5 },
        software: [
          { type: "plugin", slug: "thing", patched_versions: [],
            affected_versions: { a: { from_version: "*", from_inclusive: true, to_version: "9", to_inclusive: true } } },
          { type: "plugin", slug: "thing", patched_versions: ["2.1"],
            affected_versions: { b: { from_version: "*", from_inclusive: true, to_version: "9", to_inclusive: true } } },
        ],
      },
    };
    const entries = parseWordfenceFeed(feed);
    const [m] = matchInventory(entries, inventory("thing", "2.0"));
    expect(entries.find((e) => e.id === m.feed_id)?.fixed_in).toBe("2.1");
  });
});
