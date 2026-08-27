import sodium from "libsodium-wrappers";
import { getEnv } from "@/lib/env";

async function key(): Promise<Uint8Array> {
  await sodium.ready;
  const raw = Buffer.from(getEnv("APP_ENCRYPTION_KEY"), "base64");
  if (raw.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error("APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return new Uint8Array(raw);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const k = await key();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, k);
  return Buffer.concat([nonce, box]).toString("base64");
}

export async function decryptSecret(ciphertext: string): Promise<string> {
  const k = await key();
  const raw = Buffer.from(ciphertext, "base64");
  const nonce = new Uint8Array(raw.subarray(0, sodium.crypto_secretbox_NONCEBYTES));
  const box = new Uint8Array(raw.subarray(sodium.crypto_secretbox_NONCEBYTES));
  try {
    return sodium.to_string(sodium.crypto_secretbox_open_easy(box, nonce, k));
  } catch {
    throw new Error("Decryption failed");
  }
}
