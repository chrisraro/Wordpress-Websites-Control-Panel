"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabasePairingRepo } from "@/services/sites/pairing-repo";
import { pairingProblem } from "@/services/sites/pairing";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";

const PairInput = z.object({
  // "" clears the pairing; anything else must be a site id.
  production_site_id: z.union([z.literal(""), z.uuid()]),
});

type Result = { ok: boolean; error?: string };

/**
 * Pairs a staging copy with the production site it was taken from, or clears
 * the pairing (0026_site_production_pair.sql).
 *
 * sites.manage, like every other edit to a site record (environment, origin
 * override), plus a `manage` grant on BOTH ends: the staging row being
 * written, and the production site it will point at. Replacing or clearing
 * an existing pairing also needs a manage grant on the production site it
 * pointed at, because its page stops listing this copy.
 */
export async function setProductionPairAction(
  siteId: string,
  _prevState?: Result | null,
  formData?: FormData,
): Promise<Result> {
  const user = await requireUser();
  const gate = await checkPermission("sites.manage");
  if (isDenied(gate)) return gate;
  const self = await checkSiteAccess(siteId, "manage");
  if (isDenied(self)) return self;

  const parsed = PairInput.safeParse({
    production_site_id: String(formData?.get("production_site_id") ?? "").trim(),
  });
  if (!parsed.success) return { ok: false, error: "Choose a production site from the list." };
  const target = parsed.data.production_site_id || null;
  if (target === siteId) return { ok: false, error: "A site cannot be paired with itself." };
  if (target) {
    const other = await checkSiteAccess(target, "manage");
    if (isDenied(other)) return other;
  }

  const db = createServiceSupabase();
  const sites = supabaseSitesRepo(db);
  const pairs = supabasePairingRepo(db);
  try {
    const previous = await pairs.getProductionSiteId(siteId);
    if (previous && previous !== target) {
      const old = await checkSiteAccess(previous, "manage");
      if (isDenied(old)) return old;
    }

    if (target) {
      const [staging, production] = await Promise.all([sites.getSite(siteId), sites.getSite(target)]);
      if (!staging) return { ok: false, error: "Site not found." };
      const problem = pairingProblem(staging, production);
      if (problem) return { ok: false, error: problem };
    }

    await pairs.setProductionSiteId(siteId, target);
    await sites.insertActivity({
      actor: user.id, site_id: siteId, action: target ? "site.pair" : "site.unpair",
      detail: { production_site_id: target, previous },
    });
    for (const id of [siteId, target, previous]) {
      if (id) revalidatePath(`/sites/${id}`);
    }
    return { ok: true };
  } catch (e) {
    console.error(`[sites] could not update the production pairing for ${siteId}:`, e);
    return { ok: false, error: "Could not save the pairing." };
  }
}
