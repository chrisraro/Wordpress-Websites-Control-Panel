-- Private bucket for uploaded plugin ZIPs. Uploads happen via signed upload
-- URLs (server-issued), downloads via short-lived signed URLs — no public
-- access and no storage RLS policies needed for anon/authenticated roles.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plugins', 'plugins', false, 52428800, array['application/zip', 'application/x-zip-compressed', 'application/octet-stream'])
on conflict (id) do nothing;
