import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  readServiceAccount, buildAssertion, getAccessToken, resetTokenCacheForTests, SCOPES,
} from "@/lib/google/auth";

// A real keypair, so the assertion is verified with real RSA rather than
// asserted to "look like" a JWT. If the signing input or the base64url
// encoding is wrong, verification fails here rather than at Google.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SA = { client_email: "panel@proj.iam.gserviceaccount.com", private_key: privateKey };
const b64urlDecode = (s: string) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

beforeEach(() => resetTokenCacheForTests());
afterEach(() => { delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON; });

describe("readServiceAccount", () => {
  it("returns undefined when unset, so an unconfigured integration is not an error", () => {
    // Same contract as WORDFENCE_API_KEY: no key must leave the rest of the
    // scan working rather than failing it.
    expect(readServiceAccount()).toBeUndefined();
  });

  it("throws on something that was pasted but is not JSON", () => {
    // Silently ignoring a malformed value leaves someone staring at empty
    // charts with no reason given.
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "not json at all";
    expect(() => readServiceAccount()).toThrow(/not valid JSON/i);
  });

  it("throws when the JSON is valid but not a service account", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ hello: "world" });
    expect(() => readServiceAccount()).toThrow(/client_email or private_key/i);
  });

  it("accepts base64, because env UIs mangle a pasted PEM's newlines", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON =
      Buffer.from(JSON.stringify(SA), "utf8").toString("base64");
    expect(readServiceAccount()?.client_email).toBe(SA.client_email);
  });
});

describe("buildAssertion", () => {
  it("produces a JWT whose signature verifies against the real public key", () => {
    const jwt = buildAssertion(SA, 1_700_000_000);
    const [h, c, sig] = jwt.split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64")))
      .toBe(true);
  });

  it("carries the claims Google actually checks", () => {
    const [h, c] = buildAssertion(SA, 1_700_000_000).split(".");
    expect(JSON.parse(b64urlDecode(h))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(b64urlDecode(c))).toEqual({
      iss: SA.client_email,
      scope: SCOPES,
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_000_000 + 3600,
    });
  });

  it("asks only for read scopes", () => {
    // This panel never writes to Google, and a token that could would be a
    // liability sitting in an env var.
    expect(SCOPES).toContain("webmasters.readonly");
    expect(SCOPES).toContain("analytics.readonly");
    expect(SCOPES).not.toMatch(/analytics.edit|webmasters(?!\.readonly)/);
  });

  it("signs a key stored with literal backslash-n, as env UIs commonly do", () => {
    const escaped = privateKey.split(String.fromCharCode(10)).join(String.fromCharCode(92) + "n");
    const jwt = buildAssertion({ ...SA, private_key: escaped }, 1_700_000_000);
    const [h, c, sig] = jwt.split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64")))
      .toBe(true);
  });
});

describe("getAccessToken", () => {
  const ok = (token: string, expiresIn = 3600) =>
    (async () => new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }),
      { status: 200 })) as unknown as typeof fetch;

  it("returns undefined with no service account, without calling Google", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    expect(await getAccessToken(f)).toBeUndefined();
    expect(called).toBe(false);
  });

  it("mints once and reuses the token", async () => {
    // A fan-out across twelve sites on one instance must not mint twelve
    // identical tokens.
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(SA);
    let calls = 0;
    const f = (async () => { calls++; return new Response(
      JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await getAccessToken(f, () => 1_000_000)).toBe("tok");
    expect(await getAccessToken(f, () => 1_000_000)).toBe("tok");
    expect(calls).toBe(1);
  });

  it("re-mints once the cached token is close to expiry", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(SA);
    let calls = 0;
    const f = (async () => { calls++; return new Response(
      JSON.stringify({ access_token: `t${calls}`, expires_in: 3600 }), { status: 200 }); }) as unknown as typeof fetch;
    await getAccessToken(f, () => 0);
    // 30s before expiry: inside the 60s slack, so it must not be reused.
    expect(await getAccessToken(f, () => 3_570_000)).toBe("t2");
    expect(calls).toBe(2);
  });

  it("surfaces Google's own reason rather than a bare status", async () => {
    // "invalid_grant" is what a deleted key or a skewed clock looks like,
    // and it is the whole diagnosis. "HTTP 400" is not.
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(SA);
    const f = (async () => new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }),
      { status: 400 })) as unknown as typeof fetch;
    await expect(getAccessToken(f)).rejects.toThrow(/invalid_grant/);
  });

  it("rejects a 200 that carries no token", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(SA);
    const f = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(getAccessToken(f)).rejects.toThrow(/no access_token/i);
    void ok;
  });
});
