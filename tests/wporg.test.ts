import { describe, it, expect } from "vitest";
import { searchPlugins, popularPlugins, authorName } from "@/lib/adapters/wporg";

const API_RESPONSE = {
  info: { page: 1, pages: 3, results: 55 },
  plugins: [
    {
      slug: "akismet", name: "Akismet <strong>Anti-spam</strong>",
      version: "5.4", author: '<a href="https://automattic.com">Automattic</a>',
      rating: 92, num_ratings: 1050, active_installs: 5000000,
      short_description: "Spam protection.",
      icons: { "2x": "https://ps.w.org/akismet/assets/icon-256x256.png", "1x": "https://ps.w.org/akismet/assets/icon-128x128.png" },
      requires: "5.8", tested: "6.9", requires_php: "7.2",
    },
    { slug: "noicon", name: "NoIcon", version: "1.0", author: "Dev", rating: 0, num_ratings: 0,
      active_installs: 10, short_description: "x", icons: {}, requires: false, tested: false, requires_php: false },
  ],
};

function stub(expectUrlPart: string) {
  return (async (url: unknown) => {
    expect(String(url)).toContain(expectUrlPart);
    return new Response(JSON.stringify(API_RESPONSE), { status: 200 });
  }) as typeof fetch;
}

describe("searchPlugins", () => {
  it("queries the 1.2 API and normalizes plugins", async () => {
    const res = await searchPlugins("spam", 1, stub("action=query_plugins"));
    expect(res.total).toBe(55);
    expect(res.pages).toBe(3);
    const p = res.plugins[0];
    expect(p).toMatchObject({
      slug: "akismet", name: "Akismet Anti-spam", author: "Automattic",
      rating: 92, active_installs: 5000000, icon: "https://ps.w.org/akismet/assets/icon-256x256.png",
      requires: "5.8",
    });
    // false → null normalization; empty icons → null
    expect(res.plugins[1]).toMatchObject({ icon: null, requires: null, tested: null, requires_php: null });
  });
  it("URL-encodes the query", async () => {
    await searchPlugins("a b&c", 1, stub("request%5Bsearch%5D=a+b%26c"));
  });
  it("throws a friendly error on non-200", async () => {
    const bad = (async () => new Response("busy", { status: 503 })) as typeof fetch;
    await expect(searchPlugins("x", 1, bad)).rejects.toThrow(/wordpress\.org.*503/i);
  });
});

describe("popularPlugins", () => {
  it("uses browse=popular", async () => {
    const res = await popularPlugins(2, stub("request%5Bbrowse%5D=popular"));
    expect(res.plugins).toHaveLength(2);
  });
});

describe("authorName", () => {
  it("flattens the themes API author object to a string", () => {
    expect(authorName({ display_name: "Automattic" })).toBe("Automattic");
    expect(authorName({ user_nicename: "wordpressdotorg" })).toBe("wordpressdotorg");
    expect(authorName("<a href='#'>Someone</a>")).toBe("Someone");
  });
});
