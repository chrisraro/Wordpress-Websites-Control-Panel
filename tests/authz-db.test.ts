import { describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/authz/decide";

// server-only has no real package in this project outside Next.js's bundler;
// vitest runs in plain Node, so it must be stubbed or the import throws.
vi.mock("server-only", () => ({}));

const SERVER_SCOPED = Symbol("server-scoped client");
const SERVICE_ROLE = Symbol("service-role client");

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => SERVER_SCOPED,
  createServiceSupabase: () => SERVICE_ROLE,
}));

// Import after the mocks above so readDbFor picks up the mocked clients
// rather than the real Supabase/Next.js modules.
import { readDbFor } from "@/lib/authz/db";

function viewer(role: Viewer["role"]): Viewer {
  return { id: "u1", email: "u@example.com", role, permissions: new Set(), grants: new Map() };
}

describe("readDbFor", () => {
  it("routes a client through the user-scoped client, so RLS is the boundary", async () => {
    expect(await readDbFor(viewer("client"))).toBe(SERVER_SCOPED);
  });

  it("routes admin through the service-role client", async () => {
    expect(await readDbFor(viewer("admin"))).toBe(SERVICE_ROLE);
  });

  it("routes developer through the service-role client", async () => {
    expect(await readDbFor(viewer("developer"))).toBe(SERVICE_ROLE);
  });

  it("routes content_writer through the service-role client", async () => {
    expect(await readDbFor(viewer("content_writer"))).toBe(SERVICE_ROLE);
  });
});
