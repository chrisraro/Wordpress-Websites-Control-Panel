-- Per-user API tokens for the MCP server at /api/mcp.
--
-- A token carries no scope of its own beyond `read_only`: authentication
-- resolves it to a user id, and that user's role, permission overrides and
-- site grants are then loaded exactly as they are for a cookie session, so an
-- LLM can never exceed the person who minted the token.
--
-- token_hash is sha256 of the whole secret, not an encryption of it. The panel
-- never needs the secret back, so nothing that can read this table can produce
-- a usable token. (Site application passwords are encrypted rather than hashed
-- because they must be recovered in order to be used; tokens have no such need.)
create table api_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  token_hash    text not null unique,
  token_prefix  text not null,
  read_only     boolean not null default false,
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index api_tokens_user_id_idx on api_tokens (user_id);

-- Service-role only, like the other credential-adjacent tables: RLS is enabled
-- with no policies, so anon and authenticated clients can reach nothing here.
-- The panel reads and writes this table exclusively through
-- createServiceSupabase() after its own authz checks.
alter table api_tokens enable row level security;
