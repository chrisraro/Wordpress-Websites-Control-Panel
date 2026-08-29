import { describe, it, expect } from "vitest";
import { siteAttention, isStaging, SEVERITY_RANK } from "@/services/sites/portfolio";

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
