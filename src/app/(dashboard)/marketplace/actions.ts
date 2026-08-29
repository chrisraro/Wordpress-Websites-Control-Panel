"use server";

import { randomUUID } from "node:crypto";
import { enqueueBatch } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { SLUG_RE } from "@/services/manage/service";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";

export async function createInstallBatchAction(input: {
  source: { kind: "wporg"; slug: string } | { kind: "upload"; path: string };
  siteIds: string[];
  activate: boolean;
  /**
   * Themes fan out across sites the same way plugins do, so they ride the
   * same `plugin_install` job type; the payload's `target` tells the handler
   * which installer (and which wordpress.org API) to use. Omitted = plugin,
   * for backward compatibility with jobs already queued.
   */
  target?: "plugin" | "theme";
}): Promise<{ ok: boolean; batchId?: string; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  if (!Array.isArray(input.siteIds) || input.siteIds.length === 0) {
    return { ok: false, error: "Select at least one site" };
  }
  // Every target site must be checked — a partial check here is a
  // cross-tenant hole, since a batch that installs on N sites should not
  // proceed on any of them if the caller lacks access to even one.
  const siteChecks = await Promise.all(input.siteIds.map((id) => checkSiteAccess(id)));
  const firstDenial = siteChecks.find(isDenied);
  if (firstDenial) return firstDenial;
  if (input.source.kind === "wporg" && !SLUG_RE.test(input.source.slug)) {
    return { ok: false, error: "Invalid slug" };
  }
  if (input.source.kind === "upload" && !/^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+\.zip$/i.test(input.source.path)) {
    return { ok: false, error: "Invalid upload path" };
  }
  const db = createServiceSupabase();
  // Install batches are one item across many sites, so the batch table's
  // "Item" column needs the thing being installed, not the (per-row) site
  // name the API falls back to when a payload carries no label.
  const label =
    input.source.kind === "wporg"
      ? input.source.slug
      : input.source.path.split("/").pop() || "Uploaded package";
  try {
    const { batchId } = await enqueueBatch(supabaseJobsRepo(db), "plugin_install", input.siteIds, {
      source: input.source, activate: Boolean(input.activate), actor: user.id,
      target: input.target ?? "plugin", label,
    });
    return { ok: true, batchId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not create batch" };
  }
}

export async function prepareUploadAction(
  filename: string,
): Promise<{ ok: boolean; path?: string; token?: string; error?: string }> {
  await requireUser();
  // No siteId travels with this call — it only stages a signed upload URL in
  // a shared bucket, so there is no per-site access to check here. The
  // site-scoped check happens where the resulting path is actually used
  // (createInstallBatchAction).
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!/\.zip$/i.test(safe)) return { ok: false, error: "Only .zip files are supported" };
  const path = `uploads/${randomUUID()}/${safe}`;
  const db = createServiceSupabase();
  const { data, error } = await db.storage.from("plugins").createSignedUploadUrl(path);
  if (error || !data?.token) {
    return { ok: false, error: `Could not prepare upload: ${error?.message ?? "unknown"}` };
  }
  return { ok: true, path, token: data.token };
}
