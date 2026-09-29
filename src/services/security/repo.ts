import type { SupabaseClient } from "@supabase/supabase-js";
import type { FeedEntry } from "@/lib/adapters/vulnfeed/wordfence";
import type { VulnMatch } from "./vulns";
import type { CoverageGap, Grade, SecurityCheck, UptimeRow } from "./types";
import { COVERAGE_GAPS, isInformationalAdvisory } from "./types";

export interface OpenVuln extends VulnMatch {
  title: string;
  cve: string | null;
  fixed_in: string | null;
  first_seen: string;
  /** Universal and unfixable: listed, never scored. See isInformationalAdvisory. */
  informational: boolean;
}

export interface SecurityRepo {
  replaceFeed(entries: FeedEntry[]): Promise<number>;
  hasFeedEntries(): Promise<boolean>;
  /** Newest `updated_at` across the cached feed, or null when it's empty. */
  newestFeedUpdatedAt(): Promise<string | null>;
  feedEntriesForSlugs(keys: Array<{ type: string; slug: string }>): Promise<FeedEntry[]>;
  syncSiteVulns(siteId: string, matches: VulnMatch[]): Promise<void>;
  openVulns(siteId: string): Promise<OpenVuln[]>;
  insertChecks(siteId: string, runAt: string, checks: SecurityCheck[]): Promise<void>;
  latestChecks(siteId: string): Promise<{ runAt: string; checks: SecurityCheck[] } | null>;
  latestGrade(siteId: string): Promise<Grade | null>;
  insertUptime(rows: UptimeRow[]): Promise<void>;
  uptimeSummary(siteId: string): Promise<{
    latestOk: boolean | null; responseMs: number | null; sslDays: number | null; uptime24h: number | null;
    /** Consecutive failed checks, newest first; 0 when the latest passed. */
    failStreak?: number;
    latestAt?: string | null;
    /** Newest non-null frameability verdict in the window (0029); null = unknown. */
    frameable?: boolean | null;
  }>;
}

function toFeedRow(e: FeedEntry) {
  return {
    id: e.id,
    software_slug: e.software_slug,
    software_type: e.software_type,
    affected_versions: e.affected_versions,
    cve: e.cve,
    cvss: e.cvss,
    title: e.title,
    fixed_in: e.fixed_in,
    updated_at: new Date().toISOString(),
  };
}

function fromFeedRow(r: Record<string, unknown>): FeedEntry {
  return {
    id: r.id as string,
    title: (r.title as string) ?? "",
    cve: (r.cve as string) ?? null,
    cvss: r.cvss === null ? null : Number(r.cvss),
    software_type: r.software_type as FeedEntry["software_type"],
    software_slug: r.software_slug as string,
    affected_versions: (r.affected_versions ?? []) as FeedEntry["affected_versions"],
    fixed_in: (r.fixed_in as string) ?? null,
  };
}

export function supabaseSecurityRepo(db: SupabaseClient): SecurityRepo {
  return {
    async replaceFeed(entries) {
      // Chunked upsert: the feed is tens of thousands of rows.
      for (let i = 0; i < entries.length; i += 500) {
        const chunk = entries.slice(i, i + 500).map(toFeedRow);
        const { error } = await db.from("vuln_feed").upsert(chunk, { onConflict: "id" });
        if (error) throw new Error(`vuln_feed upsert failed: ${error.message}`, { cause: error });
      }
      return entries.length;
    },
    async hasFeedEntries() {
      const { count, error } = await db.from("vuln_feed").select("id", { head: true, count: "exact" });
      if (error) throw new Error(`vuln_feed count failed: ${error.message}`, { cause: error });
      return (count ?? 0) > 0;
    },
    async newestFeedUpdatedAt() {
      const { data, error } = await db.from("vuln_feed").select("updated_at")
        .order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`vuln_feed newestFeedUpdatedAt failed: ${error.message}`, { cause: error });
      return (data?.updated_at as string) ?? null;
    },
    async feedEntriesForSlugs(keys) {
      const slugs = [...new Set(keys.map((k) => k.slug))];
      const results: FeedEntry[] = [];
      // PostgREST caps each response at max_rows (1000 on Supabase) and a
      // popular plugin alone has hundreds of entries, so page every slug
      // chunk under a stable order until a short page, or entries past row
      // 1000 would be silently dropped and a vulnerable site graded clean.
      const PAGE = 1000;
      for (let i = 0; i < slugs.length; i += 100) {
        const chunk = slugs.slice(i, i + 100);
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await db.from("vuln_feed").select("*")
            .in("software_slug", chunk)
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1);
          if (error) throw new Error(`vuln_feed query failed: ${error.message}`, { cause: error });
          const page = data ?? [];
          results.push(...page.map(fromFeedRow));
          if (page.length < PAGE) break;
        }
      }
      const wanted = new Set(keys.map((k) => `${k.type}:${k.slug}`));
      return results.filter((e) => wanted.has(`${e.software_type}:${e.software_slug}`));
    },
    async syncSiteVulns(siteId, matches) {
      if (matches.length > 0) {
        const rows = matches.map((m) => ({
          site_id: siteId, feed_id: m.feed_id, component: m.component,
          installed_version: m.installed_version, severity: m.severity, status: "open",
        }));
        const { error } = await db.from("site_vulnerabilities")
          .upsert(rows, { onConflict: "site_id,feed_id,component" });
        if (error) throw new Error(`site_vulnerabilities upsert failed: ${error.message}`, { cause: error });
      }
      const openIds = matches.map((m) => m.feed_id);
      let q = db.from("site_vulnerabilities").update({ status: "fixed" })
        .eq("site_id", siteId).eq("status", "open");
      if (openIds.length > 0) q = q.not("feed_id", "in", `(${openIds.map((x) => `"${x}"`).join(",")})`);
      const { error } = await q;
      if (error) throw new Error(`site_vulnerabilities close failed: ${error.message}`, { cause: error });
    },
    async openVulns(siteId) {
      const { data, error } = await db.from("site_vulnerabilities")
        .select("feed_id,component,installed_version,severity,first_seen,vuln_feed(title,cve,fixed_in,affected_versions)")
        .eq("site_id", siteId).eq("status", "open").order("severity");
      if (error) throw new Error(`openVulns failed: ${error.message}`, { cause: error });
      return (data ?? []).map((r) => {
        const feed = (Array.isArray(r.vuln_feed) ? r.vuln_feed[0] : r.vuln_feed) as
          { title: string; cve: string | null; fixed_in: string | null;
            affected_versions?: Array<{ from_version: string; to_version: string }> } | null;
        const fixed_in = feed?.fixed_in ?? null;
        return {
          feed_id: r.feed_id, component: r.component, installed_version: r.installed_version,
          severity: r.severity, first_seen: r.first_seen,
          title: feed?.title ?? r.feed_id, cve: feed?.cve ?? null, fixed_in,
          informational: isInformationalAdvisory({
            fixed_in, affected_versions: feed?.affected_versions ?? [],
          }),
        };
      });
    },
    async insertChecks(siteId, runAt, checks) {
      const rows = checks.map((c) => ({
        site_id: siteId, run_at: runAt, check_id: c.check_id, result: c.result, details: c.details ?? null,
      }));
      const { error } = await db.from("security_checks").insert(rows);
      if (error) throw new Error(`security_checks insert failed: ${error.message}`, { cause: error });
    },
    async latestChecks(siteId) {
      const { data: latest, error: e1 } = await db.from("security_checks")
        .select("run_at").eq("site_id", siteId).order("run_at", { ascending: false }).limit(1).maybeSingle();
      if (e1) throw new Error(`latestChecks failed: ${e1.message}`, { cause: e1 });
      if (!latest) return null;
      const { data, error } = await db.from("security_checks")
        .select("check_id,result,details").eq("site_id", siteId).eq("run_at", latest.run_at);
      if (error) throw new Error(`latestChecks failed: ${error.message}`, { cause: error });
      return {
        runAt: latest.run_at,
        checks: (data ?? []).map((r) => ({
          check_id: r.check_id, result: r.result, details: r.details ?? undefined,
        })),
      };
    },
    async latestGrade(siteId) {
      const { data, error } = await db.from("security_checks")
        .select("details").eq("site_id", siteId).eq("check_id", "grade")
        .order("run_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`latestGrade failed: ${error.message}`, { cause: error });
      const d = data?.details as { grade?: Grade["grade"]; score?: number; incomplete?: unknown } | null;
      if (!d?.grade) return null;
      const grade: Grade = { grade: d.grade, score: d.score ?? 0 };
      // Rows written before coverage tracking carry no list: leave them
      // unmarked rather than guess. Unknown ids are dropped, not rendered.
      if (!Array.isArray(d.incomplete)) return grade;
      const incomplete = d.incomplete.filter(
        (g): g is CoverageGap => COVERAGE_GAPS.includes(g as CoverageGap),
      );
      return { ...grade, incomplete };
    },
    async insertUptime(rows) {
      if (rows.length === 0) return;
      let { error } = await db.from("uptime_checks").insert(rows);
      // Before 0029 is applied the column does not exist. Losing the verdict
      // is fine; losing the uptime row (and the alerts that read it) is not.
      if (error && /frameable/i.test(error.message)) {
        ({ error } = await db.from("uptime_checks")
          .insert(rows.map(({ frameable: _drop, ...rest }) => rest)));
      }
      if (error) throw new Error(`uptime insert failed: ${error.message}`, { cause: error });
    },
    async uptimeSummary(siteId) {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data, error } = await db.from("uptime_checks")
        // "*" rather than a column list, so this keeps working whether or
        // not 0029's frameable column exists yet.
        .select("*")
        .eq("site_id", siteId).gte("checked_at", since)
        .order("checked_at", { ascending: false }).limit(500);
      if (error) throw new Error(`uptimeSummary failed: ${error.message}`, { cause: error });
      if (!data?.length) return { latestOk: null, responseMs: null, sslDays: null, uptime24h: null };
      const latest = data[0];
      const okCount = data.filter((r) => r.ok).length;
      const streakEnd = data.findIndex((r) => r.ok);
      const judged = data.find((r) => typeof r.frameable === "boolean");
      return {
        failStreak: streakEnd === -1 ? data.length : streakEnd,
        latestAt: latest.checked_at ?? null,
        frameable: judged ? (judged.frameable as boolean) : null,
        latestOk: latest.ok,
        responseMs: latest.response_ms,
        sslDays: latest.ssl_days_remaining,
        uptime24h: Math.round((okCount / data.length) * 1000) / 10,
      };
    },
  };
}
