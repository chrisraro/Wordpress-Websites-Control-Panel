"use server";

import { randomUUID } from "node:crypto";
import { enqueueBatch, processJobs } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { buildJobHandlers } from "@/services/jobs/handlers";
import { SLUG_RE } from "@/services/manage/service";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

export async function createInstallBatchAction(input: {
  source: { kind: "wporg"; slug: string } | { kind: "upload"; path: string };
  siteIds: string[];
  activate: boolean;
}): Promise<{ ok: boolean; batchId?: string; error?: string }> {
  const user = await requireUser();
  if (!Array.isArray(input.siteIds) || input.siteIds.length === 0) {
    return { ok: false, error: "Select at least one site" };
  }
  if (input.source.kind === "wporg" && !SLUG_RE.test(input.source.slug)) {
    return { ok: false, error: "Invalid plugin slug" };
  }
  if (input.source.kind === "upload" && !/^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+\.zip$/i.test(input.source.path)) {
    return { ok: false, error: "Invalid upload path" };
  }
  const db = createServiceSupabase();
  try {
    const { batchId } = await enqueueBatch(supabaseJobsRepo(db), "plugin_install", input.siteIds, {
      source: input.source, activate: Boolean(input.activate), actor: user.id,
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

export async function processQueueNowAction(): Promise<{
  ok: boolean; done?: number; failed?: number; error?: string;
}> {
  await requireUser();
  const db = createServiceSupabase();
  try {
    const res = await processJobs(supabaseJobsRepo(db), buildJobHandlers(db), { max: 3 });
    return { ok: true, done: res.done, failed: res.failed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Queue processing failed" };
  }
}
