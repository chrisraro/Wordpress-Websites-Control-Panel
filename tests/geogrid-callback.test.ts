import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { verifyN8nRequest } from "@/lib/n8n-auth";

afterEach(() => { delete process.env.N8N_WEBHOOK_SECRET; });

const BODY = JSON.stringify({ run_id: "abc", ranks: [] });

describe("verifyN8nRequest", () => {
  it("accepts a valid HMAC signature, with or without the sha256 prefix", () => {
    process.env.N8N_WEBHOOK_SECRET = "s3cret";
    const sig = createHmac("sha256", "s3cret").update(BODY).digest("hex");
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-signature": sig }))).toBe(true);
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-signature": `sha256=${sig}` }))).toBe(true);
  });

  it("rejects a signature computed over different content", () => {
    process.env.N8N_WEBHOOK_SECRET = "s3cret";
    const sig = createHmac("sha256", "s3cret").update("other").digest("hex");
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-signature": sig }))).toBe(false);
  });

  it("accepts the shared-secret header", () => {
    process.env.N8N_WEBHOOK_SECRET = "s3cret";
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-secret": "s3cret" }))).toBe(true);
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-secret": "wrong" }))).toBe(false);
  });

  it("fails closed when no secret is configured or no auth header is sent", () => {
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-secret": "anything" }))).toBe(false);
    process.env.N8N_WEBHOOK_SECRET = "s3cret";
    expect(verifyN8nRequest(BODY, new Headers())).toBe(false);
  });
});
