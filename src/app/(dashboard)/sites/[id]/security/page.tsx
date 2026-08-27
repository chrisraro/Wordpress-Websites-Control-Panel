import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { SiteTabs } from "../tabs";
import { ManageForm, type ManageFormAction } from "../action-form";
import { runSecurityScanAction } from "../security-actions";
import type { Severity } from "@/services/security/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const GRADE_STYLE: Record<string, string> = {
  A: "bg-green-100 text-green-800", B: "bg-lime-100 text-lime-800",
  C: "bg-amber-100 text-amber-800", D: "bg-orange-100 text-orange-800",
  F: "bg-red-100 text-red-800",
};
const SEV_STYLE: Record<string, string> = {
  critical: "bg-red-100 text-red-800", high: "bg-orange-100 text-orange-800",
  medium: "bg-amber-100 text-amber-800", low: "bg-slate-200 text-slate-600",
};
const CHECK_LABELS: Record<string, string> = {
  wp_debug: "Debug mode off", debug_display: "Debug output hidden",
  file_edit_disabled: "File editor disabled", https_urls: "HTTPS site URLs",
  default_table_prefix: "Custom table prefix", admin_username: "No 'admin' username",
  default_salts: "Unique auth salts", user_registration: "Open registration off",
  php_version: "Supported PHP version", inactive_plugins: "No inactive plugins",
  wp_config_permissions: "wp-config.php permissions", xmlrpc_enabled: "XML-RPC blocked",
  uploads_listing: "Directory listing off", security_headers: "Clickjacking headers",
  core_checksums: "Core files unmodified", wordfence_feed: "Vulnerability feed",
};

export default async function SecurityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();
  const security = supabaseSecurityRepo(db);
  const [grade, vulns, latest, uptime] = await Promise.all([
    security.latestGrade(id), security.openVulns(id), security.latestChecks(id), security.uptimeSummary(id),
  ]);
  const checks = (latest?.checks ?? []).filter((c) => c.check_id !== "grade");
  const scan = runSecurityScanAction.bind(null, id) as unknown as ManageFormAction;

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">Security</p>
      <SiteTabs siteId={id} active="security" />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {grade ? (
            <>
              <span className={`rounded-lg px-4 py-2 text-2xl font-bold ${GRADE_STYLE[grade.grade]}`}>
                {grade.grade}
              </span>
              <div className="text-sm text-slate-500">
                <p>Score {grade.score}/100</p>
                {latest && <p>Scanned {new Date(latest.runAt).toLocaleString()}</p>}
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500">No scan yet — run the first one.</p>
          )}
        </div>
        <ManageForm action={scan} label="Run security scan" pendingLabel="Scanning… (may take a few minutes)"
          confirmMessage={`Run a full security scan on ${site.name} now?`}
          buttonClassName="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50" />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Uptime (24h)", value: uptime.uptime24h !== null ? `${uptime.uptime24h}%` : "—" },
          { label: "Status", value: uptime.latestOk === null ? "—" : uptime.latestOk ? "Up" : "Down" },
          { label: "Response", value: uptime.responseMs !== null ? `${uptime.responseMs} ms` : "—" },
          { label: "SSL expires", value: uptime.sslDays !== null ? `${uptime.sslDays} days` : "—" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border bg-white p-3 text-center shadow-sm">
            <p className="text-lg font-semibold">{s.value}</p>
            <p className="text-xs text-slate-500">{s.label}</p>
          </div>
        ))}
      </div>

      <section className="mb-6 rounded-lg border bg-white shadow-sm">
        <h2 className="border-b px-4 py-3 font-medium">
          Vulnerabilities {vulns.length > 0 && <span className="text-red-600">({vulns.length})</span>}
        </h2>
        {vulns.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            {latest ? "No known vulnerabilities matched." : "Run a scan to check for vulnerabilities."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2">Component</th>
                  <th className="px-4 py-2">Vulnerability</th>
                  <th className="px-4 py-2">Severity</th>
                  <th className="px-4 py-2">Installed</th>
                  <th className="px-4 py-2">Fixed in</th>
                </tr>
              </thead>
              <tbody>
                {vulns.map((v) => (
                  <tr key={`${v.feed_id}:${v.component}`} className="border-b last:border-0">
                    <td className="px-4 py-2 font-medium">{v.component}</td>
                    <td className="px-4 py-2">
                      {v.title}
                      {v.cve && (
                        <a href={`https://www.cve.org/CVERecord?id=${v.cve}`} target="_blank" rel="noreferrer"
                          className="ml-2 text-xs text-slate-500 underline">{v.cve}</a>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${SEV_STYLE[(v.severity ?? "low") as Severity]}`}>
                        {v.severity ?? "unknown"}
                      </span>
                    </td>
                    <td className="px-4 py-2">{v.installed_version}</td>
                    <td className="px-4 py-2">{v.fixed_in ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {vulns.length > 0 && (
          <p className="border-t px-4 py-3 text-xs text-slate-500">
            Fix vulnerable plugins from the Plugins tab (update to the fixed version, or deactivate).
          </p>
        )}
      </section>

      <section className="rounded-lg border bg-white shadow-sm">
        <h2 className="border-b px-4 py-3 font-medium">Hardening checklist</h2>
        {checks.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">Run a scan to populate the checklist.</p>
        ) : (
          <ul className="divide-y">
            {checks.map((c) => (
              <li key={c.check_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span>{CHECK_LABELS[c.check_id] ?? c.check_id}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${
                  c.result === "pass" ? "bg-green-100 text-green-800"
                    : c.result === "fail" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}>
                  {c.result}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
