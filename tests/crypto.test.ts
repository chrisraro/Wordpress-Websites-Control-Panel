import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("secrets", () => {
  it("round-trips a value", async () => {
    const ct = await encryptSecret("hunter2 app pass");
    expect(ct).not.toContain("hunter2");
    expect(await decryptSecret(ct)).toBe("hunter2 app pass");
  });

  it("produces different ciphertexts for same plaintext (random nonce)", async () => {
    expect(await encryptSecret("x")).not.toBe(await encryptSecret("x"));
  });

  it("throws on tampered ciphertext", async () => {
    const ct = await encryptSecret("x");
    const buf = Buffer.from(ct, "base64");
    buf[buf.length - 1] ^= 0xff;
    await expect(decryptSecret(buf.toString("base64"))).rejects.toThrow("Decryption failed");
  });
});
