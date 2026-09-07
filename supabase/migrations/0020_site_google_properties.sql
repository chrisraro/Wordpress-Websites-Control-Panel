-- Which Google properties a site corresponds to.
--
-- Neither can be derived from the site URL, which is why they are stored
-- rather than computed:
--
--   gsc_property     Search Console identifies a property one of two ways.
--                    A Domain property is "sc-domain:example.com" and covers
--                    every subdomain and path. A URL-prefix property is a
--                    URL, "https://example.com/", and covers only that
--                    prefix. Four sites here live in a subdirectory, where
--                    the correct value is the full prefix
--                    ("https://azaleabaguio.com/staging2-baguio/") and the
--                    bare domain would silently return the parent site's
--                    numbers instead. Stored verbatim as the operator copies
--                    it out of Search Console.
--
--   ga4_property_id  The numeric GA4 property id (e.g. "402551234"), NOT the
--                    measurement id (G-XXXXXXX) that appears in the page
--                    source. They look interchangeable and are not: the
--                    measurement id names a data stream, the property id
--                    names the thing the Data API reports on. Two sites here
--                    already share one measurement id, so reading it off the
--                    page would have mapped both to the same property.
--
-- Null means "not linked", which stays distinct from "linked and returned
-- nothing" everywhere downstream.
alter table sites add column if not exists gsc_property text;
alter table sites add column if not exists ga4_property_id text;

comment on column sites.gsc_property is
  'Search Console property: "sc-domain:example.com" or a URL prefix. Null = not linked.';
comment on column sites.ga4_property_id is
  'Numeric GA4 property id, not the G-XXXXXXX measurement id. Null = not linked.';
