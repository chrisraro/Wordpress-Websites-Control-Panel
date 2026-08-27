import { describe, it, expect, afterEach } from "vitest";
import { getEnv } from "@/lib/env";

describe("env", () => {
  afterEach(() => delete process.env.APP_ENCRYPTION_KEY);

  it("returns a set env var", () => {
    process.env.APP_ENCRYPTION_KEY = "abc";
    expect(getEnv("APP_ENCRYPTION_KEY")).toBe("abc");
  });

  it("throws on missing env var", () => {
    expect(() => getEnv("APP_ENCRYPTION_KEY")).toThrow(/Missing required env var/);
  });
});
