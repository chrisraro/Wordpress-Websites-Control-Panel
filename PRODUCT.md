# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, one of them live today.

**Staff — live.** A small internal team at **Online Creative Solutions (OCS)**,
a web agency: roughly two to five people across the `admin`, `developer` and
`content_writer` roles. Because the team is more than one person, the console
cannot assume its operator built it. Someone opening a screen for the first
time has to be able to tell what a control does and what it will touch.

**Clients — intended, not yet live.** External customers of the agency will be
given accounts. A client sees **only the sites granted to them**, can **read
and generate reports**, and can do nothing else — no installs, updates,
activations, or configuration. No external customer has an account yet, so
there is no usage to reason from, but this is a confirmed audience rather than
a role kept open speculatively: design the client experience as a product for
someone who does not work at OCS and did not ask for a control panel.

That framing matters more than the permission list. A client is not a member of
staff with buttons hidden — they are a customer checking on work they are
paying for. What reassures them is evidence the site is healthy and a report
they can forward, not a denser console. The agency-grade bar recorded under
constraints applies to everything a client can see, not only to the PDF.

## Product Purpose

One place to run every WordPress site OCS maintains for clients, instead of
logging into each site's wp-admin in turn.

Four distinct jobs bring the team here, all confirmed as real:

1. **Routine health check** — a sweep across the whole portfolio for what is
   broken, out of date, or newly vulnerable.
2. **Answering a client** — producing a report, a rank update, or evidence the
   site is healthy.
3. **Doing the maintenance** — running updates, installing plugins, activating
   themes, toggling maintenance mode, in bulk.
4. **Something broke** — finding a failed scan, a stuck job, or a down site
   fast.

Success is that a site's state can be understood and acted on without opening
wp-admin, and that the portfolio can be swept without visiting sites one by one.

## Positioning

The panel reaches WordPress through the **Novamira MCP adapter**, executing PHP
in the site's own runtime rather than over the REST API or WP-CLI. WP-CLI is
unavailable on this hosting, which is why the mechanism exists. That is what
lets one panel do real work — installs, activations, core updates, checksum
verification — across sites it does not host.

GeoGrid local-rank tracking is run through an external n8n workflow against
Serper, so rank measurement is a product capability rather than a bought
dashboard.

## Operating Context

- **12 WordPress sites** across client production, client staging, and OCS's
  own properties, on shared hosting.
- **Four of the sites are staging copies** of client production sites, some as
  subdirectory installs on another client's domain.
- Work is both scheduled and reactive: `pg_cron` drives a nightly enqueue, a
  five-minute uptime sweep, and a per-minute queue drain; the team also acts
  on demand.
- Long operations are queued rather than run inline, because the hosting and
  the serverless function ceilings will not hold them open.
- The team works from a desk and from a phone.

## Capabilities and Constraints

**Confirmed capabilities**

- Connect a site by URL, WordPress username and application password;
  credentials are encrypted at rest and abilities are discovered on connect.
- Inventory: WordPress and PHP version, plugins, themes, pending updates, core
  update state, and WordPress administrator accounts.
- Toolkit: install, update, activate, deactivate and delete plugins and themes;
  create child themes; upload theme and plugin archives; update core; toggle
  maintenance mode. Bulk actions with row selection across all of it.
- Security: vulnerability matching against a Wordfence feed, core checksum
  verification, hardening checks, and consecutive-failure tracking per site.
- SEO/AEO: Rank Math data and PageSpeed Insights.
- GeoGrid: 3×3 to 9×9 local rank grids per keyword, with history.
- Reports: branded PDF, stored privately, shared by a revocable token at a
  public URL; a monthly report generates automatically.
- Uptime and SSL checks.
- Role-based access with an editable role×permission matrix, per-site grants at
  read or manage level, and an activity log.

**Constraints that must be preserved**

- **Staging and production must never be visually confusable.** Running a bulk
  update against the wrong one is the expensive mistake this product can cause.
  This is the single hardest constraint on future design work.
- **It must work on a phone.** The team genuinely uses it away from a desk, so
  responsive behaviour is a primary target, not a checkbox.
- **Client-facing output must look agency-grade.** The reports PDF, the public
  share page, and every screen a signed-in client can reach are seen by paying
  customers and represent OCS; they carry a higher polish bar than the internal
  console.
- WP-CLI is unavailable; everything reaches WordPress through MCP `execute-php`.
- Staff read through a service-role database client that bypasses row-level
  security, so on staff surfaces the application code is the access boundary.
- Serverless function ceilings bound any inline operation.

**Terminology** — *site*, *client label*, *grant* (read or manage), *ability*,
*snapshot*, *GeoGrid run*, *batch*, *share token*.

## Brand Commitments

- The product is named **OCS Wordpress Control Panel**. OCS stands for Online
  Creative Solutions.
- The logo is the existing OCS badge (`ocs-logo.jpg`; derived assets in
  `public/brand/`). It is used exactly as supplied — the wordmark is baked into
  the artwork and it is not to be redrawn or simplified.

## Evidence on Hand

- 12 live client sites with working credentials, and a live database with real
  inventory, scan, GeoGrid and job history.
- Real generated reports and share links.
- `docs/ops/` carries operational runbooks written against this live system.

**Absences future work must not fabricate:** no external client has ever used
the product, so there are no client testimonials, usage numbers, satisfaction
figures, or case studies. There is no pricing, licensing, or public marketing
surface, and none is planned — this is an internal tool.

## Product Principles

1. **The wrong site is the expensive mistake.** Identity and environment of the
   thing being acted on outrank every other piece of information on screen.
2. **Show the portfolio, not the site list.** The recurring job is a sweep for
   exceptions; surfacing what needs attention beats presenting twelve equal rows.
3. **Verify against the live system rather than designing around an assumption.**
   This project has repeatedly found that structural checks pass while the live
   system disagrees.
4. **Say what is not known.** Empty, unmeasured, failed and stale are different
   states from zero, and collapsing them has produced real defects here.
5. **Client-facing artifacts represent the agency, not the tool.** A client's
   view answers "is my site in good hands?" — not "here is the console with
   most of it removed."

## Accessibility & Inclusion

No formal standard has been set. The confirmed product-specific requirement is
that the console remains fully usable on a phone. Contrast and focus behaviour
are governed by the existing design system rather than a stated external
conformance target.
