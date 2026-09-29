-- feat(sites): pair a staging copy with the production site it was taken from.
--
-- Four of the twelve connected sites are staging copies of client production
-- sites (PRODUCT.md). Until now nothing recorded WHICH production site a
-- staging copy belongs to, so "is staging still a faithful copy?" could only
-- be answered by opening two plugin tabs side by side. This column is that
-- link; the site page diffs the two latest inventory snapshots against it.
--
--   production_site_id  on the STAGING row, the production site it copies.
--                       Many staging rows may point at one production site
--                       (staging + staging2 are both real here).
--
-- ON DELETE SET NULL: removing a production site must not take its staging
-- copies with it, and must not be blocked by them either. The pairing just
-- lapses and the staging page stops showing a comparison.
--
-- Not-self is enforced here because a self-pair is a comparison that always
-- reads "In sync", which is worse than no comparison at all.
--
-- "Only meaningful when environment = 'staging'" (see 0017) is enforced in
-- the application (src/services/sites/pairing.ts), NOT by a check
-- constraint. A constraint tying this column to `environment` would make
-- "Mark as production" (setEnvironmentAction) fail outright for any paired
-- staging site, and a row-local check cannot see the OTHER row's environment
-- anyway -- the half that matters most, "the target really is production",
-- is a cross-row fact. So: the action refuses to create a pairing unless the
-- source is staging and the target is production, and every reader ignores
-- a pairing on a row that is no longer staging.
--
-- NOT GRANTED TO `authenticated`, and deliberately absent from SITE_COLUMNS
-- (src/services/sites/repo.ts). 0012 replaced the table-level select with an
-- explicit column list, so a new column is invisible to the client role until
-- a migration names it -- and this one does not, on purpose:
--
--   * the value is another site's id. A client granted only the staging copy
--     is not necessarily granted the production site, and there is no reason
--     to hand them a pointer to a site they cannot open;
--   * the drift card it drives is staff-only (it lists plugins that exist on
--     one side and not the other -- a maintenance view, not a client one).
--
-- Staff read it through the service-role client (pairing-repo.ts), which
-- ignores grants. tests/sites-repo-columns.test.ts keeps SITE_COLUMNS equal
-- to the union of column grants, so leaving both unchanged keeps that parity;
-- tests/site-pairing-migration.test.ts pins that no grant for this column
-- appears here.
--
-- Deploy order: apply before the code that reads the column (PostgREST
-- fails the whole query on an unknown column). Re-runnable: every statement
-- is guarded.

set local search_path = public;

alter table sites
  add column if not exists production_site_id uuid null
  references sites(id) on delete set null;

alter table sites drop constraint if exists sites_production_pair_not_self;
alter table sites add constraint sites_production_pair_not_self check (
  production_site_id is null or production_site_id <> id
);

-- "Which staging copies point at this production site?" is asked on every
-- production site page; the FK alone does not index the referencing column.
create index if not exists sites_production_site_id_idx
  on sites (production_site_id)
  where production_site_id is not null;

comment on column sites.production_site_id is
  'On a staging site: the production site it is a copy of. Staff-only (not '
  'granted to authenticated). Ignored unless environment = staging; the '
  'target being production is checked by the app, not the database.';
