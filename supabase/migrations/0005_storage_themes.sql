-- Private bucket for uploaded theme .zip files, mirroring the plugins bucket.
-- The browser uploads to a signed URL; the server hands WordPress a separate
-- short-lived signed download URL. Nothing is ever public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('themes', 'themes', false, 52428800, array['application/zip','application/x-zip-compressed','application/octet-stream'])
on conflict (id) do nothing;
