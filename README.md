# WP Control Panel

Internal OCS dashboard for managing client WordPress sites via their Novamira
MCP endpoints. Spec: `docs/superpowers/specs/2026-08-27-wp-control-panel-design.md`.

## Setup

1. `npm install`
2. Copy `.env.example` → `.env.local` and fill in:
   - Supabase project URL + anon key + service-role key (Project Settings → API)
   - `APP_ENCRYPTION_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
3. Apply `supabase/migrations/0001_init.sql` (`npx supabase db push`, or SQL editor).
4. In Supabase Auth settings: disable public signups; invite team members by email.
5. `npm run dev` → http://localhost:3000

## Connecting a site

The site needs the Novamira plugin active. Create an Application Password for
an admin user (WP Admin → Users → Profile → Application Passwords), then use
"+ Connect site". Credentials are encrypted at rest; all WordPress calls run
server-side over MCP.

## Commands

- `npm run dev` / `npm run build` / `npm start`
- `npm test` — Vitest suite

## Deploy (Vercel)

Set the same env vars in Vercel. `vercel.json` crons and pg_cron schedules
arrive in Phase 2 with the job system.
