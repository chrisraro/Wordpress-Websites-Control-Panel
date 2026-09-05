"use server";

import { revalidatePath } from "next/cache";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";
import { friendlySiteError } from "@/lib/mcp/errors";
import { installVerificationFile, removeVerificationFile } from "@/services/gsc/service";
import { validateVerificationFileName } from "@/services/gsc/types";

/**
 * Server actions for Search Console verification.
 *
 * Gated exactly like root-file-actions.ts, because that is what they are: a
 * write to the document root, wearing a narrower and safer interface. The
 * content is generated from the file name rather than accepted, so unlike the
 * general root-file editor this cannot put a script on the origin.
 */

type Result = { ok: boolean; message?: string; error?: string } | null;

async function gate(siteId: string) {
  await requireUser();
  const permission = await checkPermission("wp_toolkit.manage");
  if (isDenied(permission)) return permission;
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return site;
  return null;
}

export async function installVerificationAction(
  siteId: string, _prev?: Result, formData?: FormData,
): Promise<Result> {
  const denied = await gate(siteId);
  if (denied) return denied;

  const fileName = String(formData?.get("file_name") ?? "").trim();
  const nameError = validateVerificationFileName(fileName);
  if (nameError) return { ok: false, error: nameError };

  const db = createServiceSupabase();
  const deps = { repo: supabaseSitesRepo(db), mcp: createSiteMcpClient };
  try {
    const r = await installVerificationFile(deps, siteId, fileName);
    revalidatePath(`/sites/${siteId}/seo`);
    revalidatePath(`/sites/${siteId}`);

    // Two different outcomes, said differently. "Written but not fetchable"
    // is the case where telling someone it worked would send them to press
    // Verify in Search Console and watch it fail for reasons they then have
    // no way to diagnose.
    if (!r.reachable) {
      return {
        ok: false,
        error:
          `${fileName} was written to the site, but it could not be fetched back. ` +
          `${r.reachError ?? ""} Google will see the same thing, so verification would fail. ` +
          "This usually means a CDN or a security plugin is blocking it.",
      };
    }
    return {
      ok: true,
      message: r.replaced
        ? `Replaced ${fileName}, and confirmed the site serves it.`
        : `Installed ${fileName}, and confirmed the site serves it.`,
    };
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Could not install the verification file" };
  }
}

export async function removeVerificationAction(
  siteId: string, fileName: string, _prev?: Result, _formData?: FormData,
): Promise<Result> {
  const denied = await gate(siteId);
  if (denied) return denied;

  const db = createServiceSupabase();
  const deps = { repo: supabaseSitesRepo(db), mcp: createSiteMcpClient };
  try {
    await removeVerificationFile(deps, siteId, fileName);
    revalidatePath(`/sites/${siteId}/seo`);
    revalidatePath(`/sites/${siteId}`);
    return { ok: true, message: `Removed ${fileName}.` };
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Could not remove the verification file" };
  }
}
