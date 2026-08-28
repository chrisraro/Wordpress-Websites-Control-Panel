-- Private bucket for generated report PDFs. Clients never touch storage
-- directly: /r/<token>/file validates the share token and streams the object
-- with the service-role client.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('reports', 'reports', false, 26214400, array['application/pdf'])
on conflict (id) do nothing;
