-- Public storage bucket for images embedded in outbound email.
--
-- Unlike contact-files / voicemail-audio (private, served via signed URLs), an
-- image in an email must load in the recipient's mail client with no auth — so
-- this bucket is PUBLIC (objects readable by anyone holding the URL, which is
-- exactly what an <img src> in a sent email needs).
--
-- Uploads are NOT open: they go through /api/email/images (admin-only) using the
-- service-role key, which bypasses storage RLS. With RLS on storage.objects and
-- no INSERT policy for authenticated users, nobody can write here with an anon
-- token — same posture as the private buckets. Bucket-level limits below are a
-- second guard behind the route's own validation.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'email-assets',
  'email-assets',
  true,
  5242880, -- 5 MB
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
