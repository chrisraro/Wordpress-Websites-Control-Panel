import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pairingProblem, effectivePairId } from "@/services/sites/pairing";
import type { SiteRow } from "@/services/sites/types";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0026_site_production_pair.sql"),
  "utf8",
);

function site(id: string, environment: "production" | "staging", name = id): SiteRow {
  return {
    id, name, url: `https://${id}.example.com`, status: "connected", environment,
    client_label: null, capabilities: { abilities: [] },
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("0026_site_production_pair.sql", () => {
  it("adds a nullable self-referencing FK that lapses when production is deleted", () => {
    expect(MIGRATION).toMatch(/add column if not exists production_site_id uuid null/);
    expect(MIGRATION).toMatch(/references sites\(id\) on delete set null/);
  });

  it("refuses a site paired with itself", () => {
    expect(MIGRATION).toMatch(/production_site_id is null or production_site_id <> id/);
  });

  it("is re-runnable", () => {
    expect(MIGRATION).toMatch(/drop constraint if exists sites_production_pair_not_self/);
    expect(MIGRATION).toMatch(/create index if not exists/);
  });

  it("never grants the column to the client role", () => {
    // Clients must not learn the id of a production site they may not be
    // granted. Any grant to authenticated in this file is a regression.
    expect(MIGRATION).not.toMatch(/grant\s+select/i);
  });
});

describe("pairingProblem", () => {
  const staging = site("stg", "staging");
  const prod = site("prod", "production");

  it("accepts a staging site paired with a production site", () => {
    expect(pairingProblem(staging, prod)).toBeNull();
  });

  it("refuses to pair a production site", () => {
    expect(pairingProblem(site("p2", "production"), prod)).toMatch(/Only a staging site/);
  });

  it("refuses a staging target", () => {
    expect(pairingProblem(staging, site("stg2", "staging"))).toMatch(/is not marked production/);
  });

  it("refuses self-pairing", () => {
    expect(pairingProblem(staging, staging)).toMatch(/itself/);
  });

  it("refuses a missing target", () => {
    expect(pairingProblem(staging, null)).toMatch(/not found/);
  });

  it("treats a legacy row without an environment by the isStaging fallback", () => {
    const legacy = { ...site("old", "staging"), url: "https://staging.acme.example", environment: undefined };
    expect(pairingProblem(legacy, prod)).toBeNull();
  });
});

describe("effectivePairId", () => {
  it("ignores a pairing left on a site that is no longer staging", () => {
    expect(effectivePairId(site("x", "production"), "prod")).toBeNull();
  });

  it("returns the pairing for a staging site", () => {
    expect(effectivePairId(site("x", "staging"), "prod")).toBe("prod");
  });

  it("returns null when there is no pairing", () => {
    expect(effectivePairId(site("x", "staging"), null)).toBeNull();
  });
});
