import { describe, expect, it } from "vitest";
import { checkPublicHost, checkPublicHttpsUrl, isPrivateAddress } from "@/lib/net-guard";

// Security finding: a site URL / origin override could name loopback,
// RFC1918, link-local (cloud metadata) etc., turning the panel's
// authenticated outbound requests into an SSRF proxy -- and a plain http://
// URL sent the WordPress application password in cleartext.

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "0.1.2.3", "100.64.0.1", "100.127.255.255",
    "::1", "::", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:0.0.0.0",
  ])("%s is private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "93.184.216.34",
    "2606:4700:4700::1111", "::ffff:8.8.8.8",
  ])("%s is public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("checkPublicHost", () => {
  const never = async () => { throw new Error("must not resolve a literal"); };

  it("refuses localhost and *.localhost without resolving", async () => {
    expect((await checkPublicHost("localhost", never)).ok).toBe(false);
    expect((await checkPublicHost("api.localhost", never)).ok).toBe(false);
  });

  it("judges literal IPs directly, including bracketed IPv6", async () => {
    expect((await checkPublicHost("169.254.169.254", never)).ok).toBe(false);
    expect((await checkPublicHost("[::1]", never)).ok).toBe(false);
    expect((await checkPublicHost("8.8.8.8", never)).ok).toBe(true);
  });

  it("refuses a name if any resolved address is private", async () => {
    const resolve = async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }];
    expect((await checkPublicHost("mixed.example", resolve)).ok).toBe(false);
  });

  it("accepts a name that resolves only to public addresses", async () => {
    const resolve = async () => [{ address: "93.184.216.34" }];
    expect((await checkPublicHost("example.com", resolve)).ok).toBe(true);
  });

  it("refuses a name that does not resolve", async () => {
    const resolve = async () => { throw new Error("ENOTFOUND"); };
    expect((await checkPublicHost("nope.invalid", resolve)).ok).toBe(false);
  });
});

describe("checkPublicHttpsUrl", () => {
  const publicResolve = async () => [{ address: "93.184.216.34" }];

  it("refuses http://", async () => {
    const res = await checkPublicHttpsUrl("http://example.com", publicResolve);
    expect(res).toEqual({ ok: false, error: "The site URL must start with https://" });
  });

  it("refuses https to a private host", async () => {
    expect((await checkPublicHttpsUrl("https://127.0.0.1/", publicResolve)).ok).toBe(false);
  });

  it("accepts https to a public host", async () => {
    expect(await checkPublicHttpsUrl("https://example.com", publicResolve)).toEqual({ ok: true });
  });
});
