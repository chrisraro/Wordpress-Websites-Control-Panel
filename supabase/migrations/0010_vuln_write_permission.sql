-- Corrects one permission mapping in 0009.
--
-- site_vulnerabilities_write required wp_toolkit.manage, copied from the
-- adjacent site_snapshots policy. But the only code path that writes
-- site_vulnerabilities is syncSiteVulns(), reached exclusively through
-- runSecurityScanAction, which is gated on security.run -- the same action
-- that writes security_checks, whose policy already requires security.run.
--
-- No role is affected today: admin and developer hold both permissions, and
-- content_writer and client hold neither. It matters once an admin uses the
-- Phase 9b matrix editor to separate them, which is the whole point of that
-- editor -- at which point a role with wp_toolkit.manage but no security.run
-- could write vulnerability findings it can neither produce nor read.

drop policy if exists site_vulnerabilities_write on site_vulnerabilities;
create policy site_vulnerabilities_write on site_vulnerabilities
  for all to authenticated
  using ( (select authorize('security.run')) and (select has_site_grant_at_least(site_id, 'manage')) )
  with check ( (select authorize('security.run')) and (select has_site_grant_at_least(site_id, 'manage')) );
