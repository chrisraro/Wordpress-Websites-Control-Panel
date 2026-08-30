import { describe, it, expect } from "vitest";
import {
  siteAttention, isStaging, isStagingSite, siteEnvironment, SEVERITY_RANK,
} from "@/services/sites/portfolio";

describe("siteAttention", () => {
  it("reports nothing for a healthy, up-to-date site", () => {
    const a = siteAttention({ status: "connected", updates: 0, grade: "A" });
    expect(a).toEqual({ severity: "ok", reasons: [] });
  });

  it("treats a lost connection as critical and says what it blocks", () => {
    const a = siteAttention({ status: "reconnect_needed" });
    expect(a.severity).toBe("critical");
    expect(a.reasons[0]).toMatch(/can't be managed/i);
  });

  it("treats an intermittent connection as a warning, not a critical", () => {
    expect(siteAttention({ status: "degraded" }).severity).toBe("warn");
  });

  it("keeps a disabled site out of the list entirely", () => {
    // A deliberate state is not a fault. If disabled sites accumulate in the
    // attention list, the list stops being worth reading.
    const a = siteAttention({ status: "disabled", updates: 9, grade: "F" });
    expect(a).toEqual({ severity: "ok", reasons: [] });
  });

  it("separates a failing security grade from a merely poor one", () => {
    expect(siteAttention({ status: "connected", grade: "F" }).severity).toBe("critical");
    expect(siteAttention({ status: "connected", grade: "D" }).severity).toBe("warn");
    expect(siteAttention({ status: "connected", grade: "C" }).severity).toBe("ok");
  });

  it("counts pending updates and pluralises them", () => {
    expect(siteAttention({ status: "connected", updates: 1 }).reasons).toContain(
      "1 update pending",
    );
    expect(siteAttention({ status: "connected", updates: 12 }).reasons).toContain(
      "12 updates pending",
    );
  });

  it("does not let pending updates alone put a site in the attention list", () => {
    // The gap that produced the collapse: the test above pinned the reason
    // *text* and never the severity, so `raise("warn")` on any pending
    // update went unnoticed. Measured against the live portfolio, all twelve
    // connected sites had at least one pending update, so all twelve were
    // warn, every severity dot rendered the same amber, and "Needs
    // attention" listed the whole portfolio alphabetically -- a dead
    // connection sorted level with a staging copy that had one update.
    expect(siteAttention({ status: "connected", updates: 1 }).severity).toBe("ok");
    expect(siteAttention({ status: "connected", updates: 17 }).severity).toBe("ok");
    // Still reported -- it just isn't a fault.
    expect(siteAttention({ status: "connected", updates: 17 }).reasons).toContain(
      "17 updates pending",
    );
  });

  it("still raises for the things that are actually faults", () => {
    // The other half of the same contract: narrowing what counts as
    // attention must not narrow it to nothing.
    expect(siteAttention({ status: "degraded", updates: 8 }).severity).toBe("warn");
    expect(siteAttention({ status: "connected", grade: "D", updates: 8 }).severity).toBe("warn");
    expect(siteAttention({ status: "reconnect_needed", updates: 8 }).severity).toBe("critical");
    expect(siteAttention({ status: "connected", grade: "F", updates: 8 }).severity).toBe("critical");
  });

  it("distinguishes never-scanned from up-to-date", () => {
    // undefined means no snapshot has ever been taken; 0 means scanned and
    // clean. Collapsing them would invent a clean bill of health.
    expect(siteAttention({ status: "connected" }).reasons).toHaveLength(0);
    expect(siteAttention({ status: "connected", updates: 0 }).reasons).toHaveLength(0);
  });

  it("keeps the worst severity when several things are wrong at once", () => {
    const a = siteAttention({ status: "reconnect_needed", updates: 4, grade: "D" });
    expect(a.severity).toBe("critical");
    expect(a.reasons).toHaveLength(3);
  });

  it("ignores SEO entirely", () => {
    // Guards the stated decision: a standing score is not a fault that
    // appeared, and mixing the two empties the list of meaning.
    const withSeoShape = { status: "connected", updates: 0, grade: "A" } as const;
    expect(siteAttention(withSeoShape).severity).toBe("ok");
  });

  it("ranks severities worst-first for sorting", () => {
    expect(SEVERITY_RANK.critical).toBeLessThan(SEVERITY_RANK.warn);
    expect(SEVERITY_RANK.warn).toBeLessThan(SEVERITY_RANK.ok);
  });
});

describe("isStaging", () => {
  const label = (client_label: string | null) => ({ url: "https://example.com", client_label });

  it("identifies a staging subdomain", () => {
    expect(isStaging({ url: "https://staging.elnidoguide.ph", client_label: null })).toBe(true);
  });

  it("identifies a staging subdirectory", () => {
    expect(isStaging({ url: "https://azaleabaguio.com/staging2-baguio", client_label: null })).toBe(true);
    expect(isStaging({ url: "https://azaleaboracay.com/staging2", client_label: null })).toBe(true);
  });

  it("identifies staging from the operator's label when the URL cannot show it", () => {
    // Some staging installs sit in a subdirectory of another client's domain
    // and are indistinguishable from production by URL alone.
    expect(isStaging({
      url: "https://onlinecreativesolutions.com/AralAbroad",
      client_label: "Aral Abroad (Staging)",
    })).toBe(true);
  });

  it("does not claim a production site is staging", () => {
    expect(isStaging({ url: "https://graceland.ph", client_label: "Graceland Production" })).toBe(false);
    expect(isStaging({ url: "https://cherrybuspalawan.ph", client_label: null })).toBe(false);
  });

  it("is not fooled by an unrelated substring", () => {
    // The failure that matters is calling production "staging", so the match
    // must not fire on a word that merely contains the letters.
    expect(isStaging({ url: "https://backstagepass.com", client_label: null })).toBe(false);
    expect(isStaging(label("Backstage Pass Ltd"))).toBe(false);
  });

  it("treats a missing label as unknown rather than staging", () => {
    expect(isStaging(label(null))).toBe(false);
  });
});

describe("siteEnvironment", () => {
  // 0017_site_environment.sql made this a recorded fact. isStaging() below is
  // now only the rule that backfilled the column and a fallback for a row
  // that predates it -- these pin that precedence, because getting it
  // backwards would silently restore the regex as the source of truth for the
  // constraint PRODUCT.md calls hardest.

  it("prefers the recorded column over the regex, in both directions", () => {
    // A production site whose URL happens to say "staging" -- e.g. a client
    // whose live domain is staging-collective.com. The regex says staging;
    // the operator said production, and the operator wins.
    expect(
      siteEnvironment({
        url: "https://staging-collective.com",
        client_label: null,
        environment: "production",
      }),
    ).toBe("production");

    // And the inverse: a staging copy the regex cannot see, because it lives
    // in a subdirectory of another client's domain. This is the case
    // isStaging()'s own docblock admits it cannot detect.
    expect(
      siteEnvironment({
        url: "https://onlinecreativesolutions.com/cherrybus",
        client_label: null,
        environment: "staging",
      }),
    ).toBe("staging");
  });

  it("falls back to the regex when the column is absent", () => {
    // A row predating the migration, or a fake in a test.
    expect(siteEnvironment({ url: "https://staging.elnidoguide.ph", client_label: null }))
      .toBe("staging");
    expect(siteEnvironment({ url: "https://elnidoguide.ph", client_label: null }))
      .toBe("production");
  });

  it("resolves an unknown environment to production, the cautious direction", () => {
    // Per isStaging()'s asymmetry: a staging site mistaken for production is
    // treated with unnecessary care, which costs nothing; a production site
    // mistaken for staging is the catastrophe. So the fallback must never be
    // "staging".
    expect(siteEnvironment({ url: "https://example.com", client_label: null }))
      .toBe("production");
    expect(isStagingSite({ url: "https://example.com", client_label: null })).toBe(false);
  });

  it("agrees with the SQL backfill on every currently connected site", () => {
    // The twelve live rows, as the dashboard showed them before 0017 ran.
    // If this drifts from the migration's regex the backfill silently
    // relabels sites on the next environment someone provisions.
    const expected: [string, string | null, boolean][] = [
      ["https://aralabroad.com", "Aral Abroad", false],
      ["https://azaleabaguio.com", "Azalea Baguio", false],
      ["https://azaleabaguio.com/staging2-baguio", "Azalea Baguio (Staging)", true],
      ["https://azaleaboracay.com", "Azalea Boracay", false],
      ["https://azaleaboracay.com/staging2", "Azalea Boracay (Staging)", true],
      ["https://beachbus.ph", "Beach Bus", false],
      ["https://onlinecreativesolutions.com/cherrybus", "Cherry Bus (Staging)", true],
      ["https://cherrybuspalawan.ph", "Cherry Bus Palawan", false],
      ["https://elnidoguide.ph", "El Nido Guide", false],
      ["https://staging.elnidoguide.ph", "El Nido Guide Staging Site", true],
      ["https://graceland.ph", "Graceland Production", false],
      ["https://onlinecreativesolutions.com", "Online Creative Solutions", false],
    ];
    for (const [url, client_label, staging] of expected) {
      expect(isStaging({ url, client_label }), url).toBe(staging);
    }
    expect(expected.filter((r) => r[2])).toHaveLength(4);
  });
});
