"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { installTheme } from "@/services/themes/install";
import type { InstallSource } from "@/services/marketplace/install";
import { SLUG_RE } from "@/services/manage/service";
import { popularThemes, searchThemes, type WpOrgThemeResult } from "@/lib/adapters/wporg";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, getViewer, isDenied } from "@/lib/authz/server";

const UPLOAD_PATH_RE = /^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+\.zip$/i;

/**
 * Installs a theme on this one site. Bound with `siteId`, this satisfies the
 * (prevState, formData) shape `useActionState` requires; the source (a
 * wordpress.org slug or an already-uploaded path) and the activate flag ride
 * along in the form itself since, unlike `manageAction`, they vary per
 * submission rather than being fixed at bind time.
 */
export async function installThemeAction(
  siteId: string,
  _prevState?: { ok: boolean; error?: string } | null,
  formData?: FormData,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return site;
  if (!formData) return { ok: false, error: "Form data missing — please resubmit" };

  const kind = String(formData.get("source") ?? "");
  const activate = formData.get("activate") === "on";
  const db = createServiceSupabase();

  let source: InstallSource;
  if (kind === "wporg") {
    const slug = String(formData.get("slug") ?? "").trim();
    if (!SLUG_RE.test(slug)) return { ok: false, error: "Invalid theme slug" };
    source = { kind: "wporg", slug };
  } else if (kind === "upload") {
    const path = String(formData.get("path") ?? "");
    if (!UPLOAD_PATH_RE.test(path)) return { ok: false, error: "Invalid upload path" };
    const { data, error } = await db.storage.from("themes").createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) {
      return { ok: false, error: `Could not sign uploaded theme URL: ${error?.message ?? "unknown"}` };
    }
    source = { kind: "url", url: data.signedUrl };
  } else {
    return { ok: false, error: "Choose a theme to install" };
  }

  const result = await installTheme(
    { sites: supabaseSitesRepo(db), jobs: supabaseJobsRepo(db), mcp: createSiteMcpClient },
    siteId, user.id, source, activate,
  );
  revalidatePath(`/sites/${siteId}/themes`);
  // Pass WordPress's own message through: activation can be skipped even when
  // the install succeeds (a child theme whose parent is not installed), and the
  // caller must not claim the theme was activated when it was not.
  return {
    ok: result.ok,
    ...(result.output ? { message: result.output } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Mirrors `prepareUploadAction` in the marketplace, but signs into the
 *  `themes` bucket rather than `plugins`. Unlike the marketplace version,
 *  this one is per-site (it lives under sites/[id]/themes and its caller
 *  always has a siteId in scope), so it checks site access here rather than
 *  deferring to a later consumer. */
export async function prepareThemeUploadAction(
  siteId: string,
  filename: string,
): Promise<{ ok: boolean; path?: string; token?: string; error?: string }> {
  await requireUser();
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return site;
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!/\.zip$/i.test(safe)) return { ok: false, error: "Only .zip files are supported" };
  const path = `uploads/${randomUUID()}/${safe}`;
  const db = createServiceSupabase();
  const { data, error } = await db.storage.from("themes").createSignedUploadUrl(path);
  if (error || !data?.token) {
    return { ok: false, error: `Could not prepare upload: ${error?.message ?? "unknown"}` };
  }
  return { ok: true, path, token: data.token };
}

/** Thin wrapper so the (client) install panel can reach the wordpress.org
 *  themes API, which does not accept cross-origin browser requests. */
export async function searchWpThemesAction(
  q: string,
): Promise<{ ok: boolean; result?: WpOrgThemeResult; error?: string }> {
  // This proxies a public wordpress.org API and leaks nothing site-specific,
  // but an unauthenticated endpoint that makes outbound requests is still a
  // small abuse surface — so it only requires a signed-in viewer, no
  // permission or site access. getViewer() (not requireUser/requireViewer)
  // because a server action must return an inline denial, not notFound().
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: "You do not have permission to do that." };
  try {
    const result = q.trim() ? await searchThemes(q.trim()) : await popularThemes();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "wordpress.org search failed" };
  }
}
