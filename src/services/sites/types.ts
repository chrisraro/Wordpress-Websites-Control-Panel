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

/**
 * Everything needed to open an MCP connection to a site.
 *
 * `origin_ip`/`origin_sni` are the optional direct-to-origin override
 * (0019_site_origin_override.sql). They are part of this type rather than
 * fetched separately so that no call site can build a connection while
 * forgetting them -- there are nine, and one that silently omitted the
 * override would fail only for the sites that need it, which are exactly the
 * sites nobody tests against.
 */
export interface SiteCredentials {
  mcp_endpoint: string;
  wp_username: string;
  app_password_encrypted: string;
  origin_ip?: string | null;
  origin_sni?: string | null;
}
