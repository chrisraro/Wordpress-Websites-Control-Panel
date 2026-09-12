export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  read_only: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
export interface ApiTokenAuthRow {
  id: string; user_id: string; read_only: boolean;
  expires_at: string | null; revoked_at: string | null;
}
export type TokenExpiry = "none" | "30d" | "90d" | "1y";
