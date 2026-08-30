"use server";

import { revalidatePath } from "next/cache";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";
import {
  listRootFiles, putRootFile, deleteRootFile, readRootFile,
} from "@/services/rootfiles/service";
import { MAX_ROOT_FILE_BYTES, validateRootFileName } from "@/services/rootfiles/types";
import type { RootFile } from "@/services/rootfiles/types";

/**
 * Server actions for the document-root file editor.
 *
 * Every one of these gates on `wp_toolkit.manage` plus a per-site `manage`
 * grant -- the same pair every other action that changes a live WordPress
 * install requires (see manage-actions.ts). That is deliberate rather than a
 * new, narrower permission: writing a static file into the document root is
 * strictly less powerful than installing a plugin, which this permission
 * already allows, so inventing a separate gate would imply a boundary that
 * does not exist while leaving the greater capability wide open.
 *
 * What it is NOT less powerful than is worth stating plainly: an HTML file at
 * the document root is served from the site's own origin, so a script inside
 * it runs with the site's cookies and can act as any visitor who loads it.
 * The UI says so before the first upload rather than burying it here.
 */

type Result<T = unknown> = { ok: boolean; error?: string } & Partial<T>;

/** Returns the denial to hand straight back, or the acting user's id. */
async function gate(siteId: string): Promise<{ denied: Result } | { actor: string }> {
  const user = await requireUser();
  const perm = await checkPermission("wp_toolkit.manage");
  if (isDenied(perm)) return { denied: perm };
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return { denied: site };
  return { actor: user.id };
}

function deps() {
  return { repo: supabaseSitesRepo(createServiceSupabase()), mcp: createSiteMcpClient };
}

/**
 * Records who changed what. Awaited so a logging failure cannot outlive the
 * request, but swallowed so it can never fail an otherwise successful write:
 * the file is already on disk by this point and reporting an error would be
 * the wrong answer.
 */
function logActivity(actor: string, siteId: string, action: string, detail: unknown) {
  return supabaseSitesRepo(createServiceSupabase())
    .insertActivity({ actor, site_id: siteId, action, detail })
    .catch(() => undefined);
}

export async function listRootFilesAction(
  siteId: string,
): Promise<Result<{ files: RootFile[] }>> {
  const g = await gate(siteId);
  if ("denied" in g) return g.denied;
  try {
    return { ok: true, files: await listRootFiles(deps(), siteId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not list files" };
  }
}

export async function readRootFileAction(
  siteId: string, name: string,
): Promise<Result<{ content: string; isText: boolean }>> {
  const g = await gate(siteId);
  if ("denied" in g) return g.denied;
  try {
    const { content, isText } = await readRootFile(deps(), siteId, name);
    return { ok: true, content, isText };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not read the file" };
  }
}

/**
 * Creates or replaces a file from an upload.
 *
 * The name comes from the form rather than the browser's filename so a
 * rename can happen in the same step -- Chrome hands back
 * "google5addd854d9cd9c88-1.html" when you download the same verification
 * file twice, and that "-1" would silently produce a file Google never looks
 * for.
 */
export async function uploadRootFileAction(
  siteId: string,
  _prev: Result<{ url: string }> | null,
  formData: FormData,
): Promise<Result<{ url: string; sha256: string; replaced: boolean }>> {
  const g = await gate(siteId);
  if ("denied" in g) return g.denied;

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a file to upload." };
  }
  if (file.size > MAX_ROOT_FILE_BYTES) {
    return {
      ok: false,
      error: `That file is ${Math.ceil(file.size / 1024)} KB. The limit is ${MAX_ROOT_FILE_BYTES / 1024} KB.`,
    };
  }
  const typed = String(formData.get("name") ?? "").trim();
  const name = typed || file.name;
  const nameError = validateRootFileName(name);
  if (nameError) return { ok: false, error: nameError };

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const res = await putRootFile(deps(), siteId, name, buf);
    await logActivity(g.actor, siteId, "site.root_file_write", {
      name, bytes: res.bytes, replaced: res.replaced,
    });
    revalidatePath(`/sites/${siteId}`);
    return { ok: true, url: res.url, sha256: res.sha256, replaced: res.replaced };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The upload failed" };
  }
}

/** Saves edited text back over an existing file. */
export async function saveRootFileAction(
  siteId: string, name: string, content: string,
): Promise<Result<{ url: string; sha256: string }>> {
  const g = await gate(siteId);
  if ("denied" in g) return g.denied;
  const nameError = validateRootFileName(name);
  if (nameError) return { ok: false, error: nameError };

  try {
    const buf = Buffer.from(content, "utf8");
    const res = await putRootFile(deps(), siteId, name, buf);
    await logActivity(g.actor, siteId, "site.root_file_edit", { name, bytes: res.bytes });
    revalidatePath(`/sites/${siteId}`);
    return { ok: true, url: res.url, sha256: res.sha256 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the file" };
  }
}

export async function deleteRootFileAction(
  siteId: string, name: string,
): Promise<Result> {
  const g = await gate(siteId);
  if ("denied" in g) return g.denied;
  try {
    await deleteRootFile(deps(), siteId, name);
    await logActivity(g.actor, siteId, "site.root_file_delete", { name });
    revalidatePath(`/sites/${siteId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The delete failed" };
  }
}
