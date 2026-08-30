-- feat/origin-override: lets the panel reach a site whose CDN challenges it.
--
-- The problem, measured rather than assumed (docs/ops/cloudflare.md): both
-- Azalea domains sit behind Cloudflare, and every MCP call from the deployed
-- app is answered with a bot-challenge interstitial instead of reaching
-- WordPress. From a residential IP the same code succeeds. The discriminator
-- is the source IP of a datacenter egress, which no request header changes.
--
-- The clean fix is a Cloudflare WAF skip rule, but that needs access to the
-- Cloudflare account holding the zone -- these domains' nameservers point at
-- Cloudflare, so cPanel cannot do it -- and the operator does not have it.
--
-- This is the other way in: connect straight to the origin server, past the
-- CDN. Three parts, and all three are needed:
--
--   origin_ip   the TCP connection goes here instead of the DNS answer,
--               which currently resolves to Cloudflare.
--   origin_sni  the TLS SNI, and the name the certificate is verified
--               against. It is separate from the site's own hostname
--               because the origin's certificate for the domain itself has
--               expired -- Cloudflare terminates TLS at its edge, so nobody
--               noticed. The shared hosting name (e.g.
--               ngx357.inmotionhosting.com) carries a valid wildcard
--               certificate, so pointing SNI at that keeps verification on.
--   the Host header stays the site's real hostname, which is what selects
--               the right vhost. That comes from the endpoint URL and needs
--               no column.
--
-- CERTIFICATE VERIFICATION IS NOT DISABLED, and must never be. Verified
-- against origin_sni, the connection is still authenticated and encrypted --
-- what changes is that it authenticates *the server* rather than *the
-- domain*. That is a real distinction and it is why this is explicit
-- per-site configuration an operator enters, not something inferred: the
-- operator is asserting "this IP and this certificate name are my host".
-- A WordPress application password travels over this connection, so the
-- alternative -- turning verification off -- would be trading a CDN
-- challenge for a credential-interception risk. Never do that.
--
-- Both columns nullable and both required together: a site with neither
-- connects normally, which is every site but these four. See
-- src/lib/mcp/client.ts, which refuses a half-configured override rather
-- than guessing the missing half.
--
-- KNOWN FAILURE MODE, documented because it is silent: shared hosting
-- migrates accounts between servers, and when that happens origin_ip goes
-- stale and the site stops connecting with a timeout rather than anything
-- that names the cause. "Test connection" on the site page is the check;
-- docs/ops/cloudflare.md records how to find the current value.
--
-- DEPLOY ORDER: apply before deploying the code that reads these columns.
-- They join SITE_COLUMNS-adjacent reads (getSiteCredentials), and PostgREST
-- rejects a select naming a column that does not exist, failing the whole
-- query. `if not exists` makes this re-runnable.

set local search_path = public;

alter table sites add column if not exists origin_ip text;
alter table sites add column if not exists origin_sni text;

-- Cheap sanity: an IPv4/IPv6 literal, never a hostname. A hostname here
-- would be resolved by the same DNS that returns the CDN, which defeats the
-- entire point of the column.
alter table sites drop constraint if exists sites_origin_ip_is_literal;
alter table sites add constraint sites_origin_ip_is_literal check (
  origin_ip is null
  or origin_ip ~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
  or origin_ip ~ '^[0-9a-fA-F:]+$'
);

-- Both or neither. A half-configured override is a connection that fails in
-- a way nobody can read.
alter table sites drop constraint if exists sites_origin_pair;
alter table sites add constraint sites_origin_pair check (
  (origin_ip is null and origin_sni is null)
  or (origin_ip is not null and origin_sni is not null)
);

-- NOT granted to `authenticated`. 0012 replaced the table-level select with
-- an explicit column list precisely so credential-adjacent columns stay off
-- it, and these two describe how to reach the origin directly -- they belong
-- with mcp_endpoint and wp_username, which are staff-only and read through
-- the service-role client. Deliberately absent from SITE_COLUMNS for the
-- same reason; getSiteCredentials selects them explicitly.

comment on column sites.origin_ip is
  'Optional: connect to this IP instead of the DNS answer, to bypass a CDN '
  'that challenges the panel. Paired with origin_sni. Goes stale if the host '
  'migrates the account -- see docs/ops/cloudflare.md.';
comment on column sites.origin_sni is
  'Optional: TLS SNI and the name the certificate is verified against when '
  'origin_ip is set. Certificate verification stays ON; this names what it '
  'checks against, because the origin certificate for the site domain itself '
  'may have expired behind the CDN.';
