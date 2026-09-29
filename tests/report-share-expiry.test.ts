import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

// Audit 2026-09-29, still-open #7: share links never expired, and every
// monthly auto report minted a permanent live link per site per month that
// nobody asked for. Manual links now expire after 30 days, monthly reports
// get no link until someone creates one, and an expired link is the same
// uniform 404 as a revoked one. Links minted before this (null expiry) stay
// valid -- see README "Reports".

const deny = { ok: false as const, error: "You do not have permission to do that." };

vi.mock("@/lib/authz/server", () => ({
  checkPermission: vi.fn(),
  checkSiteAccess: vi.fn(),
  isDenied: (x: unknown) => typeof x === "object" && x !== null && (x as { ok?: boolean }).ok === false,
}));
const dbHolder: { db: SupabaseClient | null } = { db: null };
vi.mock("@/lib/supabase/server", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", email: "u@example.com" })),
  createServiceSupabase: vi.fn(() => {
    if (!dbHolder.db) throw new Error("must not reach the database");
    return dbHolder.db;
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { checkPermission, checkSiteAccess } from "@/lib/authz/server";
import { generateReport, type GenerateDeps } from "@/services/reports/generate";
import { supabaseReportsRepo, type ReportRow, type ReportsRepo } from "@/services/reports/repo";
import {
  SHARE_LINK_TTL_DAYS, createShareLink, shareLinkState,
} from "@/services/reports/share";
import { createShareLinkAction } from "@/app/(dashboard)/sites/[id]/reports-actions";
import { GET as fileRoute } from "@/app/r/[token]/file/route";
import type { SitesRepo } from "@/services/sites/repo";
import type { SecurityRepo } from "@/services/security/repo";
import type { SeoRepo } from "@/services/seo/repo";
import type { GeoGridRepo } from "@/services/geogrid/repo";
import type { SnapshotsRepo } from "@/services/inventory/repo";

const DAY = 24 * 3600 * 1000;
const TOKEN = "0123456789abcdef0123456789abcdef";

function row(over: Partial<ReportRow> = {}): ReportRow {
  return {
    id: "rep-1", site_id: "site-1", generated_at: "2026-09-01T00:00:00Z", sections: ["security"],
    period_start: null, period_end: null, storage_path: "site-1/x.pdf", share_token: TOKEN,
    share_expires_at: null, auto: false, security_incomplete: null, ...over,
  };
}

/** A fake supabase client: records calls, answers selects with `data`. */
function fakeDb(data: unknown) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "update", "order", "limit"]) {
    builder[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return builder; };
  }
  builder.maybeSingle = async () => ({ data, error: null });
  builder.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(ok);
  const db = {
    from(table: string) { calls.push({ method: "from", args: [table] }); return builder; },
    storage: { from() { return { async download() { return { data: new Blob([new Uint8Array([1])]), error: null }; } }; } },
  } as unknown as SupabaseClient;
  return { db, calls };
}

function generateDeps() {
  const inserted: Array<Record<string, unknown>> = [];
  const reports = {
    async insert(r: Record<string, unknown>) {
      inserted.push(r);
      return { id: "rep-1", generated_at: "", ...r } as unknown as ReportRow;
    },
  } as unknown as ReportsRepo;
  const d: GenerateDeps = {
    sites: { async getSite(id: string) { return { id, name: "S", url: "https://s.test" }; } } as unknown as SitesRepo,
    security: {
      async latestGrade() { return null; }, async openVulns() { return []; },
      async latestChecks() { return null; },
      async uptimeSummary() { return { latestOk: null, responseMs: null, sslDays: null, uptime24h: null }; },
    } as unknown as SecurityRepo,
    seo: { async latestBySource() { return {}; } } as unknown as SeoRepo,
    geogrid: { async getConfigBySite() { return null; } } as unknown as GeoGridRepo,
    snapshots: { async latestSnapshot() { return null; } } as unknown as SnapshotsRepo,
    reports,
    storage: { async upload() {}, async download() { return new Uint8Array(); } },
    render: async () => new Uint8Array([1]),
  };
  return { d, inserted };
}

beforeEach(() => {
  dbHolder.db = null;
  vi.mocked(checkPermission).mockReset();
  vi.mocked(checkSiteAccess).mockReset();
});

describe("generateReport share links", () => {
  it("gives a manual report a link that expires in 30 days", async () => {
    const { d, inserted } = generateDeps();
    const before = Date.now();
    await generateReport(d, "site-1", ["security"], 30, false);
    expect(String(inserted[0].share_token)).toMatch(/^[0-9a-f]{32}$/);
    const expires = new Date(String(inserted[0].share_expires_at)).getTime();
    expect(SHARE_LINK_TTL_DAYS).toBe(30);
    expect(expires).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(expires).toBeLessThanOrEqual(Date.now() + 30 * DAY);
  });

  it("gives a monthly auto report no link at all", async () => {
    const { d, inserted } = generateDeps();
    await generateReport(d, "site-1", ["security"], 30, true);
    expect(inserted[0]).toMatchObject({ auto: true, share_token: null, share_expires_at: null });
  });
});

describe("shareLinkState", () => {
  const now = Date.parse("2026-09-29T00:00:00Z");
  it("is active for an unexpired link and for a legacy link with no expiry", () => {
    expect(shareLinkState(row({ share_expires_at: "2026-10-01T00:00:00Z" }), now)).toBe("active");
    expect(shareLinkState(row({ share_expires_at: null }), now)).toBe("active");
  });
  it("is expired once the expiry has passed", () => {
    expect(shareLinkState(row({ share_expires_at: "2026-09-28T23:59:59Z" }), now)).toBe("expired");
    expect(shareLinkState(row({ share_expires_at: "2026-09-29T00:00:00Z" }), now)).toBe("expired");
  });
  it("is none when there is no token (never shared, or revoked)", () => {
    expect(shareLinkState(row({ share_token: null }), now)).toBe("none");
  });
});

describe("supabaseReportsRepo.getByToken", () => {
  it("returns an unexpired link", async () => {
    const future = new Date(Date.now() + DAY).toISOString();
    const { db } = fakeDb(row({ share_expires_at: future }));
    expect(await supabaseReportsRepo(db).getByToken(TOKEN)).toMatchObject({ id: "rep-1" });
  });
  it("keeps honouring a legacy link with no expiry", async () => {
    const { db } = fakeDb(row({ share_expires_at: null }));
    expect(await supabaseReportsRepo(db).getByToken(TOKEN)).toMatchObject({ id: "rep-1" });
  });
  it("treats an expired link exactly like a revoked one", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const { db } = fakeDb(row({ share_expires_at: past }));
    expect(await supabaseReportsRepo(db).getByToken(TOKEN)).toBeNull();
  });
});

describe("supabaseReportsRepo.setShareLink", () => {
  it("writes token and expiry scoped to both report id and site id", async () => {
    const { db, calls } = fakeDb(null);
    await supabaseReportsRepo(db).setShareLink("rep-1", "site-a", TOKEN, "2026-10-29T00:00:00Z");
    expect(calls).toEqual(expect.arrayContaining([
      { method: "from", args: ["reports"] },
      { method: "update", args: [{ share_token: TOKEN, share_expires_at: "2026-10-29T00:00:00Z" }] },
      { method: "eq", args: ["id", "rep-1"] },
      { method: "eq", args: ["site_id", "site-a"] },
    ]));
  });
});

describe("createShareLink", () => {
  it("mints a fresh token that expires in 30 days", async () => {
    const set: unknown[][] = [];
    const repo = { async setShareLink(...a: unknown[]) { set.push(a); } } as unknown as ReportsRepo;
    const now = Date.parse("2026-09-29T00:00:00Z");
    const out = await createShareLink(repo, "rep-1", "site-1", now);
    expect(out.token).toMatch(/^[0-9a-f]{32}$/);
    expect(out.expiresAt).toBe("2026-10-29T00:00:00.000Z");
    expect(set).toEqual([["rep-1", "site-1", out.token, out.expiresAt]]);
  });
});

describe("createShareLinkAction", () => {
  it("asks for reports.generate and refuses without it, before touching the database", async () => {
    vi.mocked(checkPermission).mockResolvedValue(deny);
    vi.mocked(checkSiteAccess).mockResolvedValue({} as never);
    const res = await createShareLinkAction("s1", "r1");
    expect(res.ok).toBe(false);
    expect(vi.mocked(checkPermission).mock.calls[0][0]).toBe("reports.generate");
  });

  it("refuses a site the caller has no grant on", async () => {
    vi.mocked(checkPermission).mockResolvedValue({} as never);
    vi.mocked(checkSiteAccess).mockResolvedValue(deny);
    const res = await createShareLinkAction("s-not-mine", "r1");
    expect(res.ok).toBe(false);
  });

  it("writes a new link for the given report on the given site", async () => {
    vi.mocked(checkPermission).mockResolvedValue({} as never);
    vi.mocked(checkSiteAccess).mockResolvedValue({} as never);
    const { db, calls } = fakeDb(null);
    dbHolder.db = db;
    const res = await createShareLinkAction("s1", "r1");
    expect(res.ok).toBe(true);
    const update = calls.find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({ share_token: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(calls).toEqual(expect.arrayContaining([
      { method: "eq", args: ["id", "r1"] }, { method: "eq", args: ["site_id", "s1"] },
    ]));
  });
});

describe("/r/<token>/file", () => {
  const call = () => fileRoute(new Request(`https://x.test/r/${TOKEN}/file`), { params: Promise.resolve({ token: TOKEN }) });

  it("serves an unexpired link", async () => {
    dbHolder.db = fakeDb(row({ share_expires_at: new Date(Date.now() + DAY).toISOString() })).db;
    expect((await call()).status).toBe(200);
  });

  it("404s an expired link with the same body as an unknown one", async () => {
    dbHolder.db = fakeDb(row({ share_expires_at: new Date(Date.now() - DAY).toISOString() })).db;
    const expired = await call();
    dbHolder.db = fakeDb(null).db;
    const unknown = await call();
    expect(expired.status).toBe(404);
    expect(await expired.text()).toBe(await unknown.text());
  });
});

describe("0024 migration: share expiry", () => {
  const SQL = readFileSync(
    new URL("../supabase/migrations/0024_report_share_expiry_and_coverage.sql", import.meta.url), "utf8",
  ).replace(/--.*$/gm, "");

  it("adds a nullable share_expires_at with no default, re-runnably", () => {
    expect(SQL).toMatch(/alter table reports\s+add column if not exists share_expires_at timestamptz\s*;/i);
  });

  it("does not touch existing links", () => {
    expect(SQL).not.toMatch(/update\s+reports/i);
  });
});
