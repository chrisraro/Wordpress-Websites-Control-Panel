import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const TOOL_DIR = path.resolve(__dirname, "../src/mcp/tools");
const files = readdirSync(TOOL_DIR).filter((f) => f.endsWith(".ts"));

describe("tool files stay above the service layer", () => {
  it("finds the tool files at all", () => {
    // A path typo would make every it.each below vacuously pass.
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)("%s reaches no repo, table or Supabase client", (file) => {
    const src = readFileSync(path.join(TOOL_DIR, file), "utf8");
    // A tool that queries directly bypasses the authorization and audit
    // behaviour every service function carries, and no behavioural test would
    // notice as long as the query happened to return the right rows.
    expect(src, `${file} constructs a repo`).not.toMatch(/Repo\(/);
    expect(src, `${file} queries a table directly`).not.toMatch(/\.from\("/);
    expect(src, `${file} builds a Supabase client`).not.toMatch(/createServiceSupabase/);
    expect(src, `${file} uses ctx.db`).not.toMatch(/ctx\.db\b/);
  });

  it.each(files)("%s gives every tool an environment warning", (file) => {
    const src = readFileSync(path.join(TOOL_DIR, file), "utf8");
    const registrations = src.match(/registerTool\(/g)?.length ?? 0;
    // Count only actual uses (the `${ENVIRONMENT_NOTE}` interpolation every
    // description carries), not the bare identifier in the import line --
    // that import-line occurrence would otherwise pad the count by one and
    // hide a description that's missing the note.
    const notes = src.match(/\$\{ENVIRONMENT_NOTE\}/g)?.length ?? 0;
    expect(notes, `${file}: ${registrations} tools but ${notes} environment notes`)
      .toBeGreaterThanOrEqual(registrations);
  });
});

describe("destructive tools all take the confirm shape", () => {
  it("every destructive tool's registration spreads CONFIRM_SHAPE", async () => {
    const { DESTRUCTIVE_TOOLS } = await import("@/mcp/tools/manage");
    const all = files.map((f) => readFileSync(path.join(TOOL_DIR, f), "utf8")).join("\n");
    const REGISTER_TAG = "registerTool(";
    for (const name of DESTRUCTIVE_TOOLS) {
      // Anchor on the actual `registerTool(` call, not just any occurrence of
      // `"${name}",` -- manage.ts's own DESTRUCTIVE_TOOLS list contains every
      // name as a plain string literal earlier in the file than the real
      // registration, so a bare indexOf(`"${name}",`) finds that list first
      // and never the registration it's meant to check.
      const registrationRe = new RegExp(
        `registerTool\\(\\s*"${name}",`,
      );
      const match = all.match(registrationRe);
      expect(match, `${name} is never registered`).not.toBeNull();
      const idx = match!.index!;
      // Bound the block to just this registration: from its `registerTool(`
      // up to the next one (or end of file), rather than a fixed character
      // count that a long enough description or schema could outrun.
      const nextIdx = all.indexOf(REGISTER_TAG, idx + REGISTER_TAG.length);
      const block = nextIdx === -1 ? all.slice(idx) : all.slice(idx, nextIdx);
      // A destructive tool without CONFIRM_SHAPE would act immediately, with
      // no dry run and no reason recorded.
      expect(block, `${name} does not spread CONFIRM_SHAPE`).toContain("...CONFIRM_SHAPE");
    }
  });
});
