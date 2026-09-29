import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SQL = readFileSync(
  new URL("../supabase/migrations/0023_fk_indexes_and_function_grants.sql", import.meta.url), "utf8",
).replace(/--.*$/gm, "");

describe("0023 foreign-key indexes and function grants", () => {
  it.each([
    "jobs (site_id, type, status)",
    "reports (site_id, generated_at desc)",
    "geogrid_configs (site_id)",
    "site_vulnerabilities (feed_id)",
    "user_site_access (site_id)",
  ])("indexes %s, re-runnably", (cols) => {
    expect(SQL).toMatch(new RegExp(`create index if not exists \\w+ on ${cols.replace(/[()]/g, "\\$&")}`));
  });

  it("revokes the PUBLIC/anon default on the RLS helper functions and keeps authenticated", () => {
    for (const fn of ["authorize(app_permission)", "has_site_access(uuid, site_access_level)"]) {
      expect(SQL).toContain(`revoke execute on function ${fn} from public, anon`);
      expect(SQL).toContain(`grant execute on function ${fn} to authenticated`);
    }
  });
});
