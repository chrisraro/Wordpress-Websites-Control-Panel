"use server";

import { revalidatePath } from "next/cache";
import { requireUser, createServiceSupabase } from "@/lib/supabase/server";
import { checkPermission, isDenied } from "@/lib/authz/server";
import { supabaseTokensRepo } from "@/services/tokens/repo";
import { mintToken, revokeToken } from "@/services/tokens/service";
import type { TokenExpiry } from "@/services/tokens/types";

const EXPIRIES: TokenExpiry[] = ["none", "30d", "90d", "1y"];

export async function createTokenAction(
  targetUserId: string,
  _prev: { ok: boolean; secret?: string; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; secret?: string; error?: string }> {
  const user = await requireUser();

  // Nobody mints a token for somebody else -- not even an admin. A token is an
  // impersonation of its owner, so issuing one on another person's behalf
  // would let an admin act as them with nothing in the audit trail to show it
  // was not really them.
  if (targetUserId !== user.id) {
    return { ok: false, error: "You can only create API tokens for yourself." };
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Give the token a name." };
  if (name.length > 80) return { ok: false, error: "The name must be 80 characters or fewer." };

  const rawExpiry = String(formData.get("expiry") ?? "");
  const expiry = EXPIRIES.find((e) => e === rawExpiry);
  if (!expiry) return { ok: false, error: "Choose a valid expiry." };

  const readOnly = formData.get("read_only") !== null;

  try {
    const { secret } = await mintToken(supabaseTokensRepo(createServiceSupabase()), {
      userId: user.id, name, readOnly, expiry,
    });
    revalidatePath(`/users/${user.id}`);
    return { ok: true, secret };
  } catch (e) {
    console.error("[tokens] mint failed:", e);
    return { ok: false, error: "Could not create the token. Try again." };
  }
}

export async function revokeTokenAction(
  tokenId: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const repo = supabaseTokensRepo(createServiceSupabase());

  const owner = await repo.getOwner(tokenId);
  if (!owner) return { ok: false, error: "Token not found." };

  if (owner.user_id !== user.id) {
    const gate = await checkPermission("users.manage");
    if (isDenied(gate)) return { ok: false, error: gate.error };
  }

  try {
    await revokeToken(repo, tokenId);
    revalidatePath(`/users/${owner.user_id}`);
    return { ok: true };
  } catch (e) {
    console.error("[tokens] revoke failed:", e);
    return { ok: false, error: "Could not revoke the token. Try again." };
  }
}
