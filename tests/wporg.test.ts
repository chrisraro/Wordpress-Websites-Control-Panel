import { describe, it, expect } from "vitest";
import { searchPlugins, popularPlugins, searchThemes, popularThemes, authorName } from "@/lib/adapters/wporg";

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

const THEME_API_RESPONSE = {
  info: { page: 1, pages: 11, results: 31 },
  themes: [
    {
      slug: "astra", name: "Astra", version: "4.13.10",
      author: { display_name: "Brainstorm Force" },
      screenshot_url: "//ts.w.org/wp-content/themes/astra/screenshot.jpg",
      preview_url: "https://wp-themes.com/astra/",
      rating: 98, num_ratings: 6514, active_installs: 1000000,
    },
  ],
};

function themeStub(expectUrlPart: string) {
  return (async (url: unknown) => {
    expect(String(url)).toContain(expectUrlPart);
    return new Response(JSON.stringify(THEME_API_RESPONSE), { status: 200 });
  }) as typeof fetch;
}

// The themes API silently ignores the JSON-blob form of `request` that this
// adapter used to send -- a search term and a browse filter both fell
// through to the same unfiltered listing. Confirmed live: only the bracketed
// query-param form (`request[search]=astra&request[per_page]=3`, the same
// shape `searchPlugins` already used) actually filters the results.
describe("searchThemes", () => {
  it("sends the bracketed query-param form with the search term and page, not a JSON blob", async () => {
    const res = await searchThemes(
      "astra", 2, themeStub("request%5Bsearch%5D=astra"),
    );
    expect(res.total).toBe(31);
    expect(res.pages).toBe(11);
    expect(res.themes[0]).toMatchObject({
      slug: "astra", name: "Astra", author: "Brainstorm Force",
      rating: 98, active_installs: 1000000,
      screenshot_url: "https://ts.w.org/wp-content/themes/astra/screenshot.jpg",
      preview_url: "https://wp-themes.com/astra/",
    });
  });

  it("includes the page number in the bracketed form", async () => {
    await searchThemes("astra", 2, themeStub("request%5Bpage%5D=2"));
  });

  it("never sends the JSON-blob `request=` form the API silently ignores", async () => {
    const spy = (async (url: unknown) => {
      expect(String(url)).not.toMatch(/[?&]request=/);
      return new Response(JSON.stringify(THEME_API_RESPONSE), { status: 200 });
    }) as typeof fetch;
    await searchThemes("astra", 1, spy);
  });

  it("throws a friendly error on non-200", async () => {
    const bad = (async () => new Response("busy", { status: 503 })) as typeof fetch;
    await expect(searchThemes("x", 1, bad)).rejects.toThrow(/wordpress\.org.*503/i);
  });
});

describe("popularThemes", () => {
  it("uses browse=popular in the bracketed form", async () => {
    const res = await popularThemes(1, themeStub("request%5Bbrowse%5D=popular"));
    expect(res.themes).toHaveLength(1);
  });
});

describe("authorName", () => {
  it("flattens the themes API author object to a string", () => {
    expect(authorName({ display_name: "Automattic" })).toBe("Automattic");
    expect(authorName({ user_nicename: "wordpressdotorg" })).toBe("wordpressdotorg");
    expect(authorName("<a href='#'>Someone</a>")).toBe("Someone");
  });

  it("degrades instead of throwing on a non-string sub-field", () => {
    // The API is not contractually guaranteed to send strings; coerce like
    // stripHtml does rather than letting .trim() throw on e.g. a number.
    expect(authorName({ display_name: 42 as unknown as string })).toBe("42");
    expect(authorName({ user_nicename: null as unknown as string })).toBe("Unknown");
  });
});

describe("HTML entity decoding", () => {
  // wordpress.org returns display titles HTML-encoded. React renders a string
  // as text, so an undecoded entity reached the user literally — every plugin
  // whose name contained a dash showed "Yoast SEO &#8211; Advanced SEO" on the
  // marketplace. Confirmed in the browser before this was fixed.
  const withName = (name: string) => ({
    info: { pages: 1, results: 1 },
    plugins: [{
      slug: "x", name, version: "1.0", author: "Dev", rating: 0, num_ratings: 0,
      active_installs: 1, short_description: "d", icons: {},
      requires: null, tested: null, requires_php: null,
    }],
  });
  const fetchWith = (body: unknown): typeof fetch =>
    (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

  const nameOf = async (raw: string) =>
    (await searchPlugins("q", 1, fetchWith(withName(raw)))).plugins[0].name;

  it("decodes the numeric entity wordpress.org actually sends", async () => {
    expect(await nameOf("Yoast SEO &#8211; Advanced SEO")).toBe("Yoast SEO – Advanced SEO");
  });

  it("decodes hex and named entities", async () => {
    expect(await nameOf("A &#x2013; B")).toBe("A – B");
    expect(await nameOf("Tools &hellip; More")).toBe("Tools … More");
    expect(await nameOf("Fast &ndash; Light")).toBe("Fast – Light");
  });

  it("decodes &amp; last so an escaped literal is not decoded twice", async () => {
    // "&amp;#8211;" is a source that literally wants to show "&#8211;".
    // Decoding &amp; first would turn it into "&#8211;" and then into a dash,
    // inventing a character the source never had.
    expect(await nameOf("Save &amp;#8211; Later")).toBe("Save &#8211; Later");
    expect(await nameOf("Black &amp; White")).toBe("Black & White");
  });

  it("still strips tags, and decoding cannot reintroduce markup", async () => {
    expect(await nameOf("Akismet <strong>Anti-spam</strong>")).toBe("Akismet Anti-spam");
    // Decoded angle brackets are safe because React renders this as text.
    // The value must never reach dangerouslySetInnerHTML.
    expect(await nameOf("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("<script>alert(1)</script>");
  });

  it("leaves an unencoded name untouched", async () => {
    expect(await nameOf("Contact Form 7")).toBe("Contact Form 7");
  });
});
