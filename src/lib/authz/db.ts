import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import type { Viewer } from "./decide";

/**
 * Which Supabase client a PAGE should read through.
 *
 * Clients get the user-scoped client, so the RLS policies from migration 0008
 * are the actual boundary: a client cannot read another client's site data
 * even if this application's code is wrong, because Postgres refuses. Staff
 * keep service-role, where authorization is the explicit check in each page.
 *
 * Writes are not routed here. Every write on every path is explicitly checked.
 */
export async function readDbFor(viewer: Viewer): Promise<SupabaseClient> {
  return viewer.role === "client" ? await createServerSupabase() : createServiceSupabase();
}
