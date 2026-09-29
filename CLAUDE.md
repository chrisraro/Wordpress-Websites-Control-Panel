# WP Control Panel — agent guide

Internal OCS console for the WordPress sites the agency maintains. It reaches
each site through the **Novamira MCP adapter** (PHP executed in the site's own
runtime — WP-CLI is unavailable on this hosting) and exposes itself over MCP at
`POST /api/mcp`. Read `PRODUCT.md` (who uses it and why) and `DESIGN.md` (UI
rules) before UI work; `docs/CODEMAPS/overview.md` for where things live.

## Stack and commands

Next.js 15 App Router · React 19 · TypeScript 6 · Supabase (Postgres + RLS +
Storage, pg_cron) · zod 4 · Vitest 4 · Tailwind 4 · deployed on Vercel.

| Task | Command |
|---|---|
| Tests (must stay green) | `npm test` |
| Typecheck | `npx tsc --noEmit` |
| Build | `npm run build` (needs the env vars in `.env.example`) |
| Live RLS check | `npm run verify:rls` (needs a real Supabase project) |

There is no linter configured; `tsc` and the test suite are the gate.

## Architecture rules

- **Every WordPress call goes through `src/lib/mcp/*`**; PHP runs via
  `runPhp()` in `src/lib/wpphp.ts`, and every untrusted value embedded in PHP
  goes through `phpString()` (base64, no injection surface). Never interpolate
  a raw value into PHP source.
- **Authorization lives in `src/lib/authz/*`** and is enforced in three places
  that must agree: server actions/pages, RLS (`supabase/migrations/0006+`),
  and MCP tools. A new action or tool checks permission *and* per-site grant.
- **Business logic lives in `src/services/<domain>`.** Route handlers, server
  actions and MCP tools are thin; MCP tools never bypass the service layer
  (pinned by a test).
- **Long work is a job**, not an inline request: enqueue into `jobs`, handled
  by `/api/cron/process`. Schedules run from pg_cron — never add Vercel crons
  (`docs/ops/scheduling.md`).
- **Schema changes are a new numbered migration** in `supabase/migrations/`;
  never edit an applied one. Update `docs/ops/authorization.md` when RLS or
  roles change.
- Secrets: site credentials are encrypted (`src/lib/crypto/secrets.ts`) and
  must never reach logs, errors, client components or MCP output.

## Conventions

- Tests live in `tests/*.test.ts` (node environment). Bug fix = failing test
  first, then the fix.
- Commits: Conventional Commits with a scope — `feat(mcp):`, `fix(security):`,
  `docs(ops):`, `test(sites):`. One logical change per commit.
- Specs go in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`,
  operator runbooks in `docs/ops/`.

## Agent workflow: Jev + ECC

Every non-trivial task in this repo runs this loop.

1. **Classify and route (Jev).** For a task with 3+ delegable subtasks, run the
   `ocs-model-router` skill first. It scores each subtask brief with Jev via
   the n8n utility "OCS — Jev Batch Triage" and routes subagents: `small` at
   certainty ≥ 0.8 → Haiku, `medium` ≥ 0.8 → Sonnet, everything else on the
   main model. Audits, security, root-cause debugging and architecture are
   `JUDGE` work and stay on the main model without a Jev call. Report the
   one-line `Routing: …` summary at the end. Skip routing for small tasks.
2. **Plan (ECC).** `/plan` or the `planner` agent for features; `architect` /
   `code-architect` for design changes; write the plan to
   `docs/superpowers/plans/`.
3. **Build test-first (ECC).** `tdd-workflow` skill / `tdd-guide` agent:
   failing test → minimal fix → green.
4. **Verify (ECC).** `verification-loop` (tests + `tsc` + build), then review
   with `typescript-reviewer`, `security-reviewer` (anything touching auth,
   tokens, PHP, uploads or outbound HTTP), `database-reviewer` (migrations,
   RLS) and `react-reviewer` (UI).
5. **Ship.** Conventional commit, push to the working branch. A cheap-model
   result is always reviewed by the main model before it is committed.

ECC is installed per cloud environment (developer profile, GateGuard off);
see the environment setup script. If ECC skills are missing in a session, do
the same steps with the built-in `code-review` / `security-review` skills.
