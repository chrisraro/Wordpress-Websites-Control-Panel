import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { requireSiteAccess } from "@/lib/authz/server";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { SiteTabs } from "../tabs";
import { ManageForm } from "../action-form";
import { runSecurityScanAction } from "../security-actions";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import {
  Card, CardTitle, EmptyState, Stat, StatusBadge, statusInk, type StatusTone,
} from "@/components/ui/primitives";
import { cardClass, tableCellClass, tableHeadClass, tableRowClass } from "@/components/ui/styles";
import { IconExternal, IconShield } from "@/components/ui/icons";
import type { Severity } from "@/services/security/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const GRADE_TONE: Record<string, StatusTone> = {
  A: "good", B: "good", C: "warn", D: "alert", F: "bad",
};
const SEV_TONE: Record<string, StatusTone> = {
  critical: "bad", high: "alert", medium: "warn", low: "idle",
};
const RESULT_TONE: Record<string, StatusTone> = {
  pass: "good", fail: "bad",
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
  await requireSiteAccess(id);
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();
  const security = supabaseSecurityRepo(db);
  const [grade, vulns, latest, uptime] = await Promise.all([
    security.latestGrade(id), security.openVulns(id), security.latestChecks(id),
    security.uptimeSummary(id),
  ]);
  const checks = (latest?.checks ?? []).filter((c) => c.check_id !== "grade");
  const failing = checks.filter((c) => c.result === "fail").length;
  const scan = runSecurityScanAction.bind(null, id);

  const scanButton = (
    <ManageForm
      action={scan}
      label="Run security scan"
      pendingLabel="Scanning…"
      success="Security scan complete"
      variant="primary"
      icon={<IconShield size={16} />}
      confirm={{
        title: "Run a full security scan?",
        description: `Checks ${site.name} against the Wordfence vulnerability feed, verifies core file checksums, and runs the hardening checklist. It reads only — nothing on the site is changed — and can take a few minutes.`,
        confirmLabel: "Run scan",
      }}
      showInlineError={false}
    />
  );

  return (
    <main>
      <Breadcrumbs
        items={[
          { label: "Sites", href: "/dashboard" },
          { label: site.name, href: `/sites/${id}` },
          { label: "Security" },
        ]}
      />
      <h1 className="mb-6 text-heading-sm font-semibold text-ink">{site.name}</h1>
      <SiteTabs siteId={id} active="security" />

      <div className={`${cardClass} mb-4 flex flex-wrap items-center justify-between gap-4 p-5`}>
        {grade ? (
          <div className="flex items-center gap-4">
            <p
              aria-hidden
              className={`flex size-16 shrink-0 items-center justify-center rounded-3xl border
                border-hairline bg-canvas text-heading-lg font-semibold
                ${statusInk(GRADE_TONE[grade.grade] ?? "idle")}`}
            >
              {grade.grade}
            </p>
            <div>
              <p className="text-body font-medium text-ink">
                Security grade {grade.grade}
                <span className="font-normal text-mid-gray"> · {grade.score}/100</span>
              </p>
              <p className="mt-0.5 text-body text-mid-gray">
                {failing > 0
                  ? `${failing} hardening ${failing === 1 ? "check" : "checks"} failing`
                  : "All hardening checks passing"}
                {latest && ` · scanned ${new Date(latest.runAt).toLocaleString()}`}
              </p>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-body font-medium text-ink">Not scanned yet</p>
            <p className="mt-0.5 text-body text-mid-gray">
              The first scan builds the grade, the vulnerability list, and the checklist below.
            </p>
          </div>
        )}
        {scanButton}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Uptime 24h"
          value={uptime.uptime24h !== null ? `${uptime.uptime24h}%` : "—"}
          tone={
            uptime.uptime24h === null ? undefined : uptime.uptime24h >= 99 ? "good" : "warn"
          }
        />
        <Stat
          label="Status"
          value={uptime.latestOk === null ? "—" : uptime.latestOk ? "Up" : "Down"}
          tone={uptime.latestOk === null ? undefined : uptime.latestOk ? "good" : "bad"}
        />
        <Stat
          label="Response"
          value={uptime.responseMs !== null ? `${uptime.responseMs} ms` : "—"}
        />
        <Stat
          label="SSL expires"
          value={uptime.sslDays !== null ? `${uptime.sslDays}d` : "—"}
          tone={uptime.sslDays === null ? undefined : uptime.sslDays <= 14 ? "bad" : "good"}
        />
      </div>

      <Card className="mb-4 overflow-hidden">
        <CardTitle
          aside={
            vulns.length > 0 ? (
              <StatusBadge tone="bad">{vulns.length} open</StatusBadge>
            ) : latest ? (
              <StatusBadge tone="good">None found</StatusBadge>
            ) : undefined
          }
        >
          Vulnerabilities
        </CardTitle>
        {vulns.length === 0 ? (
          <p className="px-5 py-6 text-body text-mid-gray">
            {latest
              ? "No installed plugin, theme, or core version matched a known vulnerability."
              : "Run a scan to check installed components against the Wordfence feed."}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-body">
                <thead>
                  <tr className={tableHeadClass}>
                    <th className="px-5 py-3 font-medium">Component</th>
                    <th className="px-5 py-3 font-medium">Vulnerability</th>
                    <th className="px-5 py-3 font-medium">Severity</th>
                    <th className="px-5 py-3 font-medium">Installed</th>
                    <th className="px-5 py-3 font-medium">Fixed in</th>
                  </tr>
                </thead>
                <tbody>
                  {vulns.map((v) => (
                    <tr key={`${v.feed_id}:${v.component}`} className={tableRowClass}>
                      <td className={`${tableCellClass} font-medium text-ink`}>{v.component}</td>
                      <td className={tableCellClass}>
                        {v.title}
                        {v.cve && (
                          <a
                            href={`https://www.cve.org/CVERecord?id=${v.cve}`}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-2 inline-flex items-center gap-1 text-caption tracking-normal
                              text-mid-gray underline transition-colors duration-150 hover:text-ink"
                          >
                            {v.cve}
                            <IconExternal size={12} />
                          </a>
                        )}
                      </td>
                      <td className={tableCellClass}>
                        <StatusBadge tone={SEV_TONE[(v.severity ?? "low") as Severity] ?? "idle"}>
                          {v.severity ?? "unknown"}
                        </StatusBadge>
                      </td>
                      <td className={`${tableCellClass} text-mid-gray`}>{v.installed_version}</td>
                      <td className={tableCellClass}>{v.fixed_in ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-hairline px-5 py-3 text-caption tracking-normal text-mid-gray">
              Fix these from the Plugins tab — update to the fixed version, or deactivate the
              component until one ships.
            </p>
          </>
        )}
      </Card>

      <Card>
        <CardTitle
          aside={
            checks.length > 0 ? (
              <StatusBadge tone={failing > 0 ? "warn" : "good"}>
                {checks.length - failing}/{checks.length} passing
              </StatusBadge>
            ) : undefined
          }
        >
          Hardening checklist
        </CardTitle>
        {checks.length === 0 ? (
          <EmptyState icon={<IconShield size={28} />} title="No checklist yet">
            Run a scan to audit this site against sixteen WordPress hardening checks.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-hairline px-5">
            {checks.map((c) => (
              <li
                key={c.check_id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-body"
              >
                <span className="text-ink">{CHECK_LABELS[c.check_id] ?? c.check_id}</span>
                <StatusBadge tone={RESULT_TONE[c.result] ?? "warn"}>{c.result}</StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
