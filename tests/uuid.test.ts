import { describe, it, expect } from "vitest";
import { isUuidShaped } from "@/lib/uuid";

// Finding 11 of the final whole-branch review: this pattern previously had
// three verbatim copies (users/[id]/page.tsx, marketplace/batches/[id]/
// page.tsx, api/batches/[id]/route.ts). Extracted here so all three share
// one definition.
describe("isUuidShaped", () => {
  it("accepts a well-formed, lowercase UUID", () => {
    expect(isUuidShaped("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("accepts an uppercase UUID", () => {
    expect(isUuidShaped("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
  });

  it("rejects a non-UUID string", () => {
    expect(isUuidShaped("not-a-uuid")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isUuidShaped("")).toBe(false);
  });

  it("rejects a UUID with the wrong segment lengths", () => {
    expect(isUuidShaped("123e4567-e89b-12d3-a456-42661417400")).toBe(false);
  });

  it("rejects a well-formed UUID with trailing garbage", () => {
    expect(isUuidShaped("123e4567-e89b-12d3-a456-426614174000-extra")).toBe(false);
  });
});
