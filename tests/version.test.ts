import { describe, it, expect } from "vitest";
import { compareVersions, versionInRange } from "@/lib/version";

describe("compareVersions", () => {
  it("compares numeric segments", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.10")).toBe(-1);
    expect(compareVersions("2.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("6.7.1.2", "6.7.1")).toBe(1);
  });
  it("treats suffixed prereleases as older than the release", () => {
    expect(compareVersions("1.2.3-beta1", "1.2.3")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3-rc1")).toBe(1);
    expect(compareVersions("1.2.3-beta1", "1.2.3-beta2")).toBe(-1);
  });
});

describe("versionInRange", () => {
  const r = (from: string, fi: boolean, to: string, ti: boolean) =>
    ({ from_version: from, from_inclusive: fi, to_version: to, to_inclusive: ti });

  it("handles bounded inclusive/exclusive ranges", () => {
    expect(versionInRange("1.5", r("1.0", true, "2.0", true))).toBe(true);
    expect(versionInRange("2.0", r("1.0", true, "2.0", true))).toBe(true);
    expect(versionInRange("2.0", r("1.0", true, "2.0", false))).toBe(false);
    expect(versionInRange("1.0", r("1.0", false, "2.0", true))).toBe(false);
    expect(versionInRange("0.9", r("1.0", true, "2.0", true))).toBe(false);
  });
  it("handles wildcard bounds (Wordfence uses *)", () => {
    expect(versionInRange("0.1", r("*", true, "5.3.9", true))).toBe(true);
    expect(versionInRange("5.4", r("*", true, "5.3.9", true))).toBe(false);
    expect(versionInRange("99.0", r("2.0", true, "*", true))).toBe(true);
  });
});
