import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiTokenAuthRow, ApiTokenRow } from "./types";

export interface TokensRepo {
  insert(row: {
    user_id: string; name: string; token_hash: string; token_prefix: string;
    read_only: boolean; expires_at: string | null;
  }): Promise<{ id: string }>;
  findByHash(tokenHash: string): Promise<ApiTokenAuthRow | null>;
  listForUser(userId: string): Promise<ApiTokenRow[]>;
  getOwner(tokenId: string): Promise<{ user_id: string } | null>;
  revoke(tokenId: string): Promise<void>;
  stampUsed(tokenId: string, atIso: string): Promise<void>;
}

const LIST_COLS =
  "id,user_id,name,token_prefix,read_only,expires_at,last_used_at,revoked_at,created_at";

export function supabaseTokensRepo(db: SupabaseClient): TokensRepo {
  return {
    async insert(row) {
      const { data, error } = await db
        .from("api_tokens").insert(row).select("id").single();
      if (error) throw new Error(error.message);
      return { id: data.id as string };
    },
    async findByHash(tokenHash) {
      const { data, error } = await db
        .from("api_tokens")
        .select("id,user_id,read_only,expires_at,revoked_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as ApiTokenAuthRow | null) ?? null;
    },
    async listForUser(userId) {
      const { data, error } = await db
        .from("api_tokens").select(LIST_COLS)
        .eq("user_id", userId).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as ApiTokenRow[];
    },
    async getOwner(tokenId) {
      const { data, error } = await db
        .from("api_tokens").select("user_id").eq("id", tokenId).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { user_id: string } | null) ?? null;
    },
    async revoke(tokenId) {
      const { error } = await db
        .from("api_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", tokenId);
      if (error) throw new Error(error.message);
    },
    async stampUsed(tokenId, atIso) {
      const { error } = await db
        .from("api_tokens").update({ last_used_at: atIso }).eq("id", tokenId);
      if (error) throw new Error(error.message);
    },
  };
}
