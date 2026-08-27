export type SiteStatus = "connected" | "degraded" | "reconnect_needed" | "disabled";

export interface SiteRow {
  id: string;
  name: string;
  url: string;
  mcp_endpoint: string;
  wp_username: string;
  status: SiteStatus;
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
}
