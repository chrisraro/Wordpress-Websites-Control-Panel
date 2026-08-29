import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// getViewer is the single place that decides what a signed-in user may do —
// every page and server action goes through it. These tests exist because
// Finding 1 (a database error silently treated as "no rows") was invisible
// without them: the module had zero coverage before this file.
//
// `server-only` has no real package installed in this project (Next.js
// injects it into the client bundler only); vitest runs in plain Node, so it
// must be stubbed or the import throws "Cannot find package".
vi.mock("server-only", () => ({}));

// react's cache() memoizes per request-render; that's irrelevant here and
// would otherwise leak state between tests (getViewer is a module-level
// singleton), so replace it with the identity function.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: <T,>(fn: T): T => fn };
});

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u@example.com" } as { id: string; email: string | null } | null,
  db: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
  createServiceSupabase: () => state.db,
}));

// Import after the mocks above so getViewer picks up the mocked
// dependencies rather than the real Supabase/Next.js modules.
import { getViewer } from "@/lib/authz/server";

type QueryResult = { data: unknown; error: { message: string } | null };

/** Mimics a supabase-js PostgrestFilterBuilder: chainable, and awaitable
 *  directly (for list queries) or via .maybeSingle() (for single-row ones). */
function fakeQuery(result: QueryResult) {
  const promise = Promise.resolve(result);
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => promise,
    then: (
      onFulfilled?: (v: QueryResult) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => promise.then(onFulfilled, onRejected),
  };
  return builder;
}

type TableName =
  | "user_roles"
  | "user_permission_overrides"
  | "user_site_access"
  | "role_permissions";

function defaultResponses(): Record<TableName, QueryResult> {
  return {
    user_roles: { data: { role: "developer" }, error: null },
    user_permission_overrides: { data: [], error: null },
    user_site_access: { data: [], error: null },
    role_permissions: { data: [{ permission: "seo.run" }], error: null },
  };
}

function fakeDb(overrides: Partial<Record<TableName, QueryResult>> = {}) {
  const responses = { ...defaultResponses(), ...overrides };
  return {
    from(table: string) {
      const result = responses[table as TableName];
      if (!result) throw new Error(`unexpected table in test: ${table}`);
      return fakeQuery(result);
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  state.user = { id: "u1", email: "u@example.com" };
  state.db = fakeDb();
});

describe("getViewer — happy paths", () => {
  it("assembles a viewer from role, permissions and grants", async () => {
    state.db = fakeDb({
      role_permissions: {
        data: [{ permission: "seo.run" }, { permission: "reports.generate" }],
        error: null,
      },
      user_site_access: { data: [{ site_id: "s1", access_level: "manage" }], error: null },
    });

    const viewer = await getViewer();

    expect(viewer).not.toBeNull();
    expect(viewer!.id).toBe("u1");
    expect(viewer!.role).toBe("developer");
    expect(viewer!.permissions.has("seo.run")).toBe(true);
    expect(viewer!.permissions.has("reports.generate")).toBe(true);
    expect(viewer!.grants.get("s1")).toBe("manage");
  });

  it("an allow override adds a permission the role lacks", async () => {
    state.db = fakeDb({
      role_permissions: { data: [{ permission: "seo.run" }], error: null },
      user_permission_overrides: {
        data: [{ permission: "users.manage", effect: "allow" }],
        error: null,
      },
    });

    const viewer = await getViewer();

    expect(viewer!.permissions.has("seo.run")).toBe(true);
    expect(viewer!.permissions.has("users.manage")).toBe(true);
  });

  it("a deny override removes a permission the role grants", async () => {
    state.db = fakeDb({
      role_permissions: { data: [{ permission: "seo.run" }], error: null },
      user_permission_overrides: {
        data: [{ permission: "seo.run", effect: "deny" }],
        error: null,
      },
    });

    const viewer = await getViewer();

    expect(viewer!.permissions.has("seo.run")).toBe(false);
  });
});

describe("getViewer — deny paths", () => {
  it("returns null when there is no session", async () => {
    state.user = null;

    expect(await getViewer()).toBeNull();
  });

  it("returns null when there is no user_roles row", async () => {
    state.db = fakeDb({ user_roles: { data: null, error: null } });

    expect(await getViewer()).toBeNull();
  });

  it("returns null for an unrecognized role string", async () => {
    // Guards against the enum (Postgres) and the AppRole union (TypeScript)
    // drifting: an unrecognized value must deny, not flow through as a cast.
    state.db = fakeDb({ user_roles: { data: { role: "superadmin" }, error: null } });

    expect(await getViewer()).toBeNull();
  });
});

describe("getViewer — database errors fail closed", () => {
  const cases: TableName[] = [
    "user_roles",
    "user_permission_overrides",
    "user_site_access",
    "role_permissions",
  ];

  for (const table of cases) {
    // This is Finding 1's regression test for `user_permission_overrides`:
    // against the pre-fix code (which only checked `?? []` on overrides.data)
    // this case returns a fully-assembled viewer instead of null, because a
    // `data: null` error response was silently treated as "no overrides".
    it(`returns null and logs when ${table} errors`, async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      state.db = fakeDb({ [table]: { data: null, error: { message: "connection reset" } } });

      const viewer = await getViewer();

      expect(viewer).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        "[authz] failed to load viewer:",
        table,
        "connection reset",
      );
      // Never leak the raw error object (it could carry connection details) —
      // only the table name and message should reach the log.
      for (const call of errorSpy.mock.calls) {
        for (const arg of call) {
          expect(arg).not.toHaveProperty("stack");
        }
      }

      errorSpy.mockRestore();
    });
  }
});
