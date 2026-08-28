import { describe, it, expect, afterEach } from "vitest";
import { stubProvider } from "@/services/geogrid/providers/stub";
import { createN8nProvider } from "@/services/geogrid/providers/n8n";
import { buildGrid } from "@/services/geogrid/grid";
import type { ProviderRequest } from "@/services/geogrid/types";

afterEach(() => {
  delete process.env.N8N_GEOGRID_WEBHOOK_URL;
  delete process.env.N8N_WEBHOOK_SECRET;
});

function req(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    keyword: "coffee shop",
    businessName: "Test Cafe",
    placeRef: null,
    points: buildGrid(14.6, 120.98, 3, 1000),
    callbackUrl: "https://panel.test/api/webhooks/n8n/geogrid",
    ...over,
  };
}

describe("stubProvider", () => {
  it("returns one rank per point, in order", async () => {
    const r = await stubProvider.run(req());
    expect(r.kind).toBe("ranks");
    if (r.kind !== "ranks") throw new Error("unreachable");
    expect(r.ranks).toHaveLength(9);
    expect(r.ranks.map((p) => p.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const p of r.ranks) {
      expect(p.rank === null || (p.rank >= 1 && p.rank <= 20)).toBe(true);
    }
  });

  it("is deterministic for the same keyword and grid", async () => {
    const a = await stubProvider.run(req());
    const b = await stubProvider.run(req());
    if (a.kind !== "ranks" || b.kind !== "ranks") throw new Error("unreachable");
    expect(a.ranks).toEqual(b.ranks);
  });

  it("varies by keyword", async () => {
    const a = await stubProvider.run(req({ keyword: "coffee shop" }));
    const b = await stubProvider.run(req({ keyword: "bakery" }));
    if (a.kind !== "ranks" || b.kind !== "ranks") throw new Error("unreachable");
    expect(a.ranks).not.toEqual(b.ranks);
  });

  it("ranks the centre at least as well as the corners", async () => {
    const r = await stubProvider.run(req({ points: buildGrid(14.6, 120.98, 5, 1000) }));
    if (r.kind !== "ranks") throw new Error("unreachable");
    const centre = r.ranks[12].rank ?? 99;
    const corner = r.ranks[0].rank ?? 99;
    expect(centre).toBeLessThanOrEqual(corner);
  });
});

describe("createN8nProvider", () => {
  it("posts the run payload and reports awaiting", async () => {
    process.env.N8N_GEOGRID_WEBHOOK_URL = "https://n8n.test/webhook/geogrid";
    process.env.N8N_WEBHOOK_SECRET = "s3cret";
    let seen: { url: string; body: unknown; headers: Record<string, string> } | null = null;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen = {
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers as Record<string, string>,
      };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const outcome = await createN8nProvider(fetchImpl).run(req());
    expect(outcome).toEqual({ kind: "awaiting" });
    expect(seen!.url).toBe("https://n8n.test/webhook/geogrid");
    expect(seen!.headers["x-n8n-secret"]).toBe("s3cret");
    expect(seen!.body).toMatchObject({
      run_id: "11111111-1111-4111-8111-111111111111",
      keyword: "coffee shop",
      business: { name: "Test Cafe", place_ref: null },
      callback_url: "https://panel.test/api/webhooks/n8n/geogrid",
    });
    expect((seen!.body as { points: unknown[] }).points).toHaveLength(9);
  });

  it("throws a clear error when the webhook URL is not configured", async () => {
    await expect(createN8nProvider().run(req())).rejects.toThrow(/N8N_GEOGRID_WEBHOOK_URL/);
  });

  it("throws when n8n rejects the request", async () => {
    process.env.N8N_GEOGRID_WEBHOOK_URL = "https://n8n.test/webhook/geogrid";
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await expect(createN8nProvider(fetchImpl).run(req())).rejects.toThrow(/404/);
  });
});
