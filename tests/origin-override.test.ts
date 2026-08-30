import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLIENT = readFileSync(join(process.cwd(), "src", "lib", "mcp", "client.ts"), "utf8");
const CONNECT = readFileSync(join(process.cwd(), "src", "lib", "mcp", "connect.ts"), "utf8");
const MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0019_site_origin_override.sql"),
  "utf8",
);

describe("direct-to-origin override", () => {
  // The override exists so the panel can reach a site whose CDN challenges
  // its egress. The tempting shortcut -- turning off certificate
  // verification -- would trade a bot challenge for a
  // credential-interception risk, on a connection carrying a WordPress
  // application password. These pin that it was not taken.
  it("never disables TLS verification", () => {
    // Comments are stripped first: the docblock in client.ts names
    // `rejectUnauthorized` precisely to say it is never touched, and a test
    // that cannot tell prose from code would fail on its own explanation.
    // Line filtering rather than a comment-stripping regex -- the escapes
    // that needs are exactly the ones that collapse when written inline.
    const code = (src: string) =>
      src
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n");

    for (const src of [code(CLIENT), code(CONNECT)]) {
      expect(src).not.toMatch(/rejectUnauthorized/);
      expect(src).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
      expect(src).not.toMatch(/checkServerIdentity/);
    }
  });

  it("verifies against an explicit servername rather than the connected IP", () => {
    // Setting `servername` is what keeps verification meaningful once the
    // connection is pinned to an IP: Node checks the presented certificate
    // against this name.
    expect(CLIENT).toContain("servername: sni");
    expect(CLIENT).toContain("lookup:");
  });

  it("leaves the request URL alone, so the Host header still picks the vhost", () => {
    // The whole approach depends on three things being different: the IP
    // connected to, the name verified, and the Host sent. Rewriting the URL
    // to the origin name would collapse the third into the second and serve
    // the wrong site on shared hosting.
    expect(CLIENT).toContain("new URL(opts.endpoint)");
  });

  it("refuses a half-configured override instead of guessing", () => {
    expect(CLIENT).toContain("hasIp !== hasSni");
    // And the database refuses it too, so a direct SQL edit cannot create one.
    expect(MIGRATION).toContain("sites_origin_pair");
  });

  it("releases the connection pool when the client closes", () => {
    // The Agent owns sockets; the nightly fan-out opens one per site.
    expect(CLIENT).toMatch(/dispatcher\?\.close\(\)/);
  });

  it("requires a literal IP at the database level, not a hostname", () => {
    // A hostname would be resolved by the same DNS that answers with the
    // CDN, which defeats the entire point.
    expect(MIGRATION).toContain("sites_origin_ip_is_literal");
  });

  it("keeps the override columns off the client-readable grant", () => {
    // 0012 replaced the table-level select with an explicit column list.
    // These two describe a route past the CDN and must not join it.
    expect(MIGRATION).not.toMatch(/grant select \([^)]*origin_(ip|sni)/);
  });
});

describe("connectToSite", () => {
  it("is the only place a connection is built from stored credentials", () => {
    // Nine services open connections. If any built the options inline it
    // could omit the override and fail only for the sites that need it --
    // which are exactly the sites nobody tests against.
    expect(CONNECT).toContain("originIp: creds.origin_ip");
    expect(CONNECT).toContain("originSni: creds.origin_sni");
  });
});
