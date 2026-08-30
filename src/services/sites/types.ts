export type SiteStatus = "connected" | "degraded" | "reconnect_needed" | "disabled";

/**
 * Which environment a site is, as declared by the operator when they
 * connected it (0017_site_environment.sql).
 *
 * Optional on SiteRow only so code compiled against a database that predates
 * the column still type-checks; every row the migration touches has a value,
 * and `siteEnvironment()` in portfolio.ts resolves the absent case.
 */
export type SiteEnvironment = "production" | "staging";

export interface SiteRow {
  id: string;
  name: string;
  url: string;
  status: SiteStatus;
  environment?: SiteEnvironment;
  client_label: string | null;
  capabilities: { abilities: string[] };
  created_at: string;
  updated_at: string;
}

export interface NewSiteInput {
  name: string;
  url: string;
  wpUsername: string;
  appPassword: string;
  clientLabel?: string;
  environment: SiteEnvironment;
}
