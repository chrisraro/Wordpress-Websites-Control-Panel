import { describe, it, expect, vi } from "vitest";
import { runAlerts, type AlertsRepo } from "@/services/alerts/service";
import type { AlertState } from "@/services/alerts/types";

const NOW = new Date("2026-09-29T12:00:00Z");
const CONFIG = { url: "https://n8n.test/hook", secret: "sek" };
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

type Loaded = Omit<AlertState, "now" | "appUrl">;
const EMPTY: Loaded = { sites: [], uptime: [], vulns: [], failedJobs: [], history: [] };
const DOWN: Loaded = {
  ...EMPTY,
  sites: [{ id: "s1", name: "Alpha", status: "connected" }],
  uptime: [
    { site_id: "s1", ok: false, checked_at: minsAgo(0), http_status: 500, ssl_days_remaining: 90 },
    { site_id: "s1", ok: false, checked_at: minsAgo(5), http_status: 500, ssl_days_remaining: 90 },
  ],
};

function fakeRepo(loaded: Loaded = EMPTY, recordError?: Error) {
  const repo = {
    loadState: vi.fn(async (_now: Date) => loaded),
    recordSent: vi.fn(async () => { if (recordError) throw recordError; }),
  } satisfies AlertsRepo;
  return repo;
}
const log = () => ({ info: vi.fn(), error: vi.fn() });
const okFetch = () => vi.fn(async () => new Response("{}", { status: 200 }));

describe("runAlerts", () => {
  it("is a no-op without configuration: logs once at info, reads nothing, sends nothing", async () => {
    const repo = fakeRepo(DOWN);
    const fetchImpl = okFetch();
    const logger = log();
    const r = await runAlerts({ repo, config: null, fetchImpl, now: NOW, appUrl: null, log: logger });
    expect(r).toEqual({ sent: 0, error: null });
    expect(repo.loadState).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(String(logger.info.mock.calls[0][0])).toMatch(/N8N_ALERT_WEBHOOK_URL/);
  });

  it("makes no request and records nothing when there is nothing new", async () => {
    const repo = fakeRepo(EMPTY);
    const fetchImpl = okFetch();
    const r = await runAlerts({ repo, config: CONFIG, fetchImpl, now: NOW, appUrl: null, log: log() });
    expect(r).toEqual({ sent: 0, error: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.recordSent).not.toHaveBeenCalled();
  });

  it("sends new alerts in one request, then records them", async () => {
    const repo = fakeRepo(DOWN);
    const fetchImpl = okFetch();
    const r = await runAlerts({ repo, config: CONFIG, fetchImpl, now: NOW, appUrl: "https://p.test", log: log() });
    expect(r).toEqual({ sent: 1, error: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(repo.loadState).toHaveBeenCalledWith(NOW);
    expect(repo.recordSent).toHaveBeenCalledTimes(1);
    const recorded = (repo.recordSent.mock.calls[0] as unknown[])[0] as Array<{ kind: string; site_id: string }>;
    expect(recorded).toEqual([expect.objectContaining({ kind: "site_down", site_id: "s1" })]);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown[] as [string, RequestInit])[1].body));
    expect(body.alerts[0].message).toContain("https://p.test/sites/s1");
  });

  it("does not record alerts when the send fails, so the next run retries", async () => {
    const repo = fakeRepo(DOWN);
    const fetchImpl = vi.fn(async () => new Response("", { status: 502 }));
    await expect(runAlerts({ repo, config: CONFIG, fetchImpl, now: NOW, appUrl: null, log: log() }))
      .rejects.toThrow(/HTTP 502/);
    expect(repo.recordSent).not.toHaveBeenCalled();
  });

  it("reports (does not throw) when the email went out but recording failed", async () => {
    const repo = fakeRepo(DOWN, new Error("insert failed"));
    const logger = log();
    const r = await runAlerts({ repo, config: CONFIG, fetchImpl: okFetch(), now: NOW, appUrl: null, log: logger });
    expect(r.sent).toBe(1);
    expect(r.error).toMatch(/record/i);
    expect(logger.error).toHaveBeenCalled();
  });
});
