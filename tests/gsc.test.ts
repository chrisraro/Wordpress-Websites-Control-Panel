import { describe, it, expect, vi } from "vitest";
import {
  gscStatus, expectedFileBody, validateVerificationFileName,
} from "@/services/gsc/types";

describe("gscStatus", () => {
  it("distinguishes 'never measured' from 'nothing installed'", () => {
    // The distinction the whole badge rests on. A snapshot taken before this
    // field existed has no value for it, and rendering that as "not
    // installed" sends someone to fix something that may be fine.
    expect(gscStatus(undefined)).toBeNull();
    expect(gscStatus({ files: [], plugin: null })).toEqual({
      state: "none", methods: [], problems: [],
    });
  });

  it("reports a well-formed file as installed", () => {
    const name = "google5addd854d9cd9c88.html";
    const s = gscStatus({ files: [{ name, declared: name }], plugin: null })!;
    expect(s.state).toBe("installed");
    expect(s.methods).toEqual(["HTML file"]);
  });

  it("catches a file copied from another site and renamed", () => {
    // The classic failure: the file exists, looks present in an FTP listing,
    // and Google rejects it because the body names a different token.
    const s = gscStatus({
      files: [{ name: "googleaaaaaaaaaaaa.html", declared: "googlebbbbbbbbbbbb.html" }],
      plugin: null,
    })!;
    expect(s.state).toBe("malformed");
    expect(s.methods).toEqual([]);
    expect(s.problems[0]).toContain("contains the token for googlebbbbbbbbbbbb.html");
  });

  it("catches an empty or unreadable file", () => {
    const s = gscStatus({
      files: [{ name: "googleaaaaaaaaaaaa.html", declared: null }], plugin: null,
    })!;
    expect(s.state).toBe("malformed");
    expect(s.problems[0]).toContain("empty or unreadable");
  });

  it("counts a DNS record as installed, and names it domain-wide", () => {
    // Three production sites here are verified purely by DNS. Without this
    // they each showed "No verification" -- a badge crying wolf on healthy
    // sites, which is worse than no badge because it teaches people to stop
    // reading it. Named "whole domain" because that is what a DNS record
    // covers: for the subdirectory installs it is the parent domain's record.
    const s = gscStatus({ files: [], plugin: null, dns: ["google-site-verification=abc"] })!;
    expect(s.state).toBe("installed");
    expect(s.methods).toEqual(["DNS record (whole domain)"]);
  });

  it("treats an empty dns array as looked-and-found-none", () => {
    expect(gscStatus({ files: [], plugin: null, dns: [] })!.state).toBe("none");
  });

  it("counts an SEO plugin's stored token as installed", () => {
    const s = gscStatus({ files: [], plugin: { name: "Rank Math", token: "abc" } })!;
    expect(s.state).toBe("installed");
    expect(s.methods).toEqual(["Rank Math meta tag"]);
  });

  it("still reports a broken file when another method works", () => {
    // Azalea's real shape: a good plugin tag AND a file. If the file were
    // broken the site would still be verified, but the broken file is worth
    // saying so nobody trusts it later.
    const s = gscStatus({
      files: [{ name: "googleaaaaaaaaaaaa.html", declared: "googlebbbbbbbbbbbb.html" }],
      plugin: { name: "Yoast", token: "t" },
    })!;
    expect(s.state).toBe("installed");
    expect(s.problems).toHaveLength(1);
  });
});

describe("verification file naming", () => {
  it("generates a body that names its own file", () => {
    expect(expectedFileBody("google5addd854d9cd9c88.html"))
      .toBe("google-site-verification: google5addd854d9cd9c88.html");
  });

  it("refuses anything that could be a path", () => {
    expect(validateVerificationFileName("../googleaaaaaaaaaaaa.html")).toBeTruthy();
    expect(validateVerificationFileName("a/googleaaaaaaaaaaaa.html")).toBeTruthy();
    expect(validateVerificationFileName("a\\googleaaaaaaaaaaaa.html")).toBeTruthy();
  });

  it("refuses names Google would never issue", () => {
    expect(validateVerificationFileName("verify.html")).toBeTruthy();
    expect(validateVerificationFileName("google.html")).toBeTruthy();
    // Multi-extension: mod_mime dispatches on any segment, so a name like
    // this must never be accepted by anything that writes to a web root.
    expect(validateVerificationFileName("googleaaaaaaaaaaaa.php.html")).toBeTruthy();
  });

  it("accepts what Search Console actually hands out", () => {
    expect(validateVerificationFileName("google5addd854d9cd9c88.html")).toBeNull();
  });
});

describe("installVerificationFile", () => {
  async function subject(over: {
    fetchImpl?: typeof fetch; siteUrl?: string;
  } = {}) {
    const put = vi.fn(async () => ({
      url: "https://example.com/googleaaaaaaaaaaaa.html",
      bytes: 53, sha256: "deadbeef", replaced: false,
    }));
    vi.doMock("@/services/rootfiles/service", () => ({
      putRootFile: put,
      deleteRootFile: vi.fn(),
    }));
    vi.resetModules();
    const { installVerificationFile } = await import("@/services/gsc/service");
    const deps = {
      repo: { getSite: async () => ({ url: over.siteUrl ?? "https://example.com" }) },
      mcp: {},
    } as never;
    return { put, run: (n = "googleaaaaaaaaaaaa.html") =>
      installVerificationFile(deps, "s1", n, over.fetchImpl ?? (async () =>
        new Response("google-site-verification: googleaaaaaaaaaaaa.html")) as typeof fetch) };
  }

  it("writes a body generated from the name, never one supplied by a caller", async () => {
    // A mismatched name/body pair is the most common way this method fails,
    // and generating the body makes it unrepresentable through this panel.
    const { put, run } = await subject();
    await run();
    const written = (put.mock.calls[0] as unknown[])[3] as Buffer;
    expect(written.toString("utf8")).toBe("google-site-verification: googleaaaaaaaaaaaa.html");
  });

  it("reports reachable only when the public URL really serves the file", async () => {
    const { run } = await subject();
    expect((await run()).reachable).toBe(true);
  });

  it("reports a 200 that is not the file as unreachable", async () => {
    // A catch-all route or a soft-404 answers 200 with a page. Writing
    // succeeded; Google would still fail.
    const { run } = await subject({
      fetchImpl: (async () => new Response("<html>Page not found</html>")) as typeof fetch,
    });
    const r = await run();
    expect(r.reachable).toBe(false);
    expect(r.reachError).toContain("something other than the verification file");
  });

  it("reports an HTTP error without failing the install", async () => {
    // The bytes are on disk either way. Throwing here would tell the operator
    // the install failed when what actually failed was the CDN in front of it.
    const { run } = await subject({
      fetchImpl: (async () => new Response("no", { status: 403 })) as typeof fetch,
    });
    const r = await run();
    expect(r.reachable).toBe(false);
    expect(r.reachError).toContain("403");
    expect(r.sha256).toBe("deadbeef");
  });

  it("survives the fetch throwing outright", async () => {
    const { run } = await subject({
      fetchImpl: (async () => { throw new Error("ETIMEDOUT"); }) as typeof fetch,
    });
    const r = await run();
    expect(r.reachable).toBe(false);
    expect(r.reachError).toContain("ETIMEDOUT");
  });

  it("builds the public URL correctly for a subdirectory install", async () => {
    // Four of twelve sites here live in a subdirectory; a naive origin+name
    // would probe the parent domain's root and report a false failure.
    let asked = "";
    const { run } = await subject({
      siteUrl: "https://azaleabaguio.com/staging2-baguio/",
      fetchImpl: (async (u: string) => {
        asked = String(u);
        return new Response("google-site-verification: googleaaaaaaaaaaaa.html");
      }) as unknown as typeof fetch,
    });
    await run();
    expect(asked).toBe("https://azaleabaguio.com/staging2-baguio/googleaaaaaaaaaaaa.html");
  });

  it("refuses a bad name before touching the site", async () => {
    const { put, run } = await subject();
    await expect(run("../evil.html")).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
  });
});
