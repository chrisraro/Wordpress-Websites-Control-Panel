import { describe, expect, it } from "vitest";
import { clientHealth } from "@/app/(dashboard)/dashboard/client-home";
import type { SiteRow } from "@/services/sites/types";

const site = (over: Partial<SiteRow> = {}): SiteRow => ({
  id: "s1", name: "Azalea Boracay", url: "https://azaleaboracay.com",
  status: "connected", client_label: null, capabilities: { abilities: [] },
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("clientHealth", () => {
  // PRODUCT.md principle 4: empty, unmeasured, failed and stale are different
  // states. This screen's audience is the least able to tell them apart, so
  // the never-measured case is the one that must never read as reassurance.
  it("never says a site is healthy when nothing has been measured", () => {
    const r = clientHealth({ site: site(), severity: "ok", lastCheckedIso: null });
    expect(r.tone).not.toBe("good");
    expect(r.line).not.toMatch(/healthy/i);
    expect(r.line).toMatch(/haven.t completed a check/i);
  });

  it("reassures only when a real check found nothing wrong", () => {
    const r = clientHealth({ site: site(), severity: "ok", lastCheckedIso: "2026-08-29T00:00:00Z" });
    expect(r.tone).toBe("good");
    expect(r.line).toMatch(/healthy/i);
  });

  it.each([["warn"], ["critical"]] as const)(
    "tells a client work is under way when severity is %s, without naming the mechanism",
    (severity) => {
      const r = clientHealth({
        site: site({ status: "degraded" }), severity, lastCheckedIso: "2026-08-29T00:00:00Z",
      });
      expect(r.tone).toBe("warn");
      // The staff wording must never leak: a client cannot act on any of
      // these and should not be handed the agency's internal vocabulary.
      for (const word of [
        "degraded", "snapshot", "inventory", "MCP", "abilities", "grade",
        "reconnect", "intermittently", "queue", "job",
      ]) {
        expect(r.line.toLowerCase()).not.toContain(word.toLowerCase());
      }
    },
  );

  it("does not claim a disabled site is healthy", () => {
    const r = clientHealth({
      site: site({ status: "disabled" }), severity: "ok", lastCheckedIso: "2026-08-29T00:00:00Z",
    });
    expect(r.tone).toBe("idle");
    expect(r.line).toMatch(/isn.t being monitored/i);
  });

  it("puts never-measured ahead of every other state", () => {
    // A disabled site that was also never checked must still say "not
    // checked" rather than "not monitored" -- the stronger absence wins.
    const r = clientHealth({
      site: site({ status: "disabled" }), severity: "critical", lastCheckedIso: null,
    });
    expect(r.line).toMatch(/haven.t completed a check/i);
  });
});
