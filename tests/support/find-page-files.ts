import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Recursively lists every `page.tsx` under `dir`. Extracted here because it
 * had been copied verbatim into tests/authz-read-path.test.ts and
 * tests/users-pages-require-permission.test.ts (final whole-branch review,
 * finding 9) -- the same duplication `isUuidShaped` was pulled out of
 * src/lib/uuid.ts to avoid, just on the test side instead.
 */
export function findPageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findPageFiles(full));
    } else if (entry === "page.tsx") {
      out.push(full);
    }
  }
  return out;
}
