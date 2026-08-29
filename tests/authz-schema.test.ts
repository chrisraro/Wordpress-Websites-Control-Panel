import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { APP_PERMISSIONS, APP_ROLES, DEFAULT_MATRIX } from "@/lib/authz/types";

const SQL = readFileSync("supabase/migrations/0006_rbac_schema.sql", "utf8");

describe("SQL enums match the TypeScript unions", () => {
  it("declares every role, and no others", () => {
    const m = SQL.match(/create type app_role as enum \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const inSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(inSql.sort()).toEqual([...APP_ROLES].sort());
  });

  it("declares every permission, and no others", () => {
    const m = SQL.match(/create type app_permission as enum \(([\s\S]*?)\);/);
    expect(m).not.toBeNull();
    const inSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(inSql.sort()).toEqual([...APP_PERMISSIONS].sort());
  });
});

describe("DEFAULT_MATRIX matches the seeded rows", () => {
  it("seeds exactly the pairs the matrix declares", () => {
    const seeded = [...SQL.matchAll(/\('(\w+)',\s*'([\w.]+)'\)/g)].map(([, r, p]) => `${r}:${p}`);
    const declared = APP_ROLES.flatMap((r) => DEFAULT_MATRIX[r].map((p) => `${r}:${p}`));
    expect(seeded.sort()).toEqual(declared.sort());
  });

  it("gives client exactly one permission — reports.generate", () => {
    expect(DEFAULT_MATRIX.client).toEqual(["reports.generate"]);
  });

  it("gives admin every permission", () => {
    expect([...DEFAULT_MATRIX.admin].sort()).toEqual([...APP_PERMISSIONS].sort());
  });
});
