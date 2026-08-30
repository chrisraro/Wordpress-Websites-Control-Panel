-- fix/critique-open-items: makes a site's environment a recorded fact rather
-- than a guess.
--
-- PRODUCT.md names running an action against the wrong environment as the
-- expensive mistake this product can cause, and four of the twelve connected
-- sites are staging copies of client production sites. Until now the only
-- thing that knew which was which was `isStaging()`
-- (src/services/sites/portfolio.ts) -- a regex over the URL and the
-- operator-set label, run fresh on every render.
--
-- A regex is the wrong shape for this. Its own docblock concedes that some
-- staging installs are subdirectory paths on another client's domain and are
-- undetectable from the URL; it works today only because all four staging
-- sites happen to have "Staging" in their display name, which is a naming
-- coincidence and not a safeguard. The operator knows the answer for certain
-- at exactly one moment -- when they connect the site -- and the form did not
-- ask. This column is that answer.
--
-- After this lands, `isStaging()` stays in the codebase as the backfill rule
-- and as a fallback for any row predating the column. It is no longer the
-- source of truth.
--
-- DEFAULT IS 'production' ON PURPOSE, and it is the safe direction. Per
-- isStaging()'s asymmetry: a staging site mistaken for production gets
-- treated with unnecessary care, which costs nothing, while a production site
-- mistaken for staging is the catastrophe. So an unspecified environment must
-- read as the one that earns more caution, never less.
--
-- HARD DEPLOY-ORDER DEPENDENCY -- apply this migration BEFORE deploying the
-- code that reads it. `environment` is added to SITE_COLUMNS
-- (src/services/sites/repo.ts), and PostgREST rejects a select naming a
-- column that does not exist -- it fails the whole query, not just that
-- field. Deploying first would 400 every site read in the application:
-- the dashboard, every site page, the marketplace pickers, and the palette.
-- The reverse order is safe -- old code simply never selects the new column,
-- like any other additive migration. `if not exists` makes this re-runnable.

set local search_path = public;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'site_environment') then
    create type site_environment as enum ('production', 'staging');
  end if;
end
$$;

alter table sites
  add column if not exists environment site_environment not null default 'production';

-- Backfill mirrors isStaging() exactly, so the twelve existing rows land on
-- the same answer the UI has been showing. Written as POSIX regex: Postgres
-- spells the word boundary `\y`, not `\b`, and `~*` is the case-insensitive
-- match. Both halves are consulted for the same reason the function consults
-- both -- a subdirectory staging install is invisible in the URL and is only
-- identifiable from the label.
update sites
set environment = 'staging'
where environment = 'production'
  and (
    url ~* '(^|//|\.)staging|/staging|\ystage[0-9]*\y|\.test\y|\.local\y'
    or coalesce(client_label, '') ~* 'staging|\ystage\y'
  );

-- REQUIRED, not optional. 0012 replaced `authenticated`'s table-level select
-- on `sites` with a column-level grant naming each readable column, so a new
-- column is unreadable to the client role until it is named here too. Without
-- this line PostgREST fails the WHOLE query for any client-role viewer the
-- moment `environment` joins SITE_COLUMNS -- every page they can reach.
-- Staff are unaffected (the service-role client bypasses grants entirely),
-- which is exactly what would make this break reach production unnoticed.
-- tests/sites-repo-columns.test.ts pins the two lists to each other.
grant select (environment) on sites to authenticated;

comment on column sites.environment is
  'Operator-declared environment, chosen when the site is connected. '
  'Authoritative: isStaging() in portfolio.ts is now only the backfill rule '
  'and a fallback for rows predating this column. Defaults to production '
  'because mistaking production for staging is the expensive direction.';
