import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseReportsRepo, supabaseReportStorage } from "@/services/reports/repo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOKEN_RE = /^[0-9a-f]{32}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!TOKEN_RE.test(token)) return new Response("Not found", { status: 404 });

  const db = createServiceSupabase();
  const report = await supabaseReportsRepo(db).getByToken(token);
  // A revoked report has share_token = null, so getByToken cannot return it.
  if (!report) return new Response("Not found", { status: 404 });

  let pdf: Uint8Array;
  try {
    pdf = await supabaseReportStorage(db).download(report.storage_path);
  } catch {
    // Same response as every other failure: this public surface exposes no
    // distinguishable states (malformed / unknown / revoked / missing file).
    return new Response("Not found", { status: 404 });
  }

  const filename = `report-${report.generated_at.slice(0, 10)}.pdf`;
  return new Response(Buffer.from(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
