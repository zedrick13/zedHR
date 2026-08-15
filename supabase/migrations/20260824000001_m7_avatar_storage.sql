-- SPEC.md M7: avatar upload — Storage bucket + RLS (§2's "avatars public
-- bucket" and §6's Edge Function note: "Storage RLS confines writes to
-- the caller's own prefix"). The actual signed-upload-URL minting and
-- validation happens in the get_avatar_upload_url Edge Function (Storage's
-- signed-upload-URL API is an HTTP operation, not something a Postgres
-- RPC can call) — this migration is the defense-in-depth backstop: even a
-- client bypassing the Edge Function and calling Storage directly with
-- their own JWT can only write inside their own
-- organizations/{org}/users/{uid}/avatars/ prefix.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Path shape: organizations/{org_id}/users/{user_id}/avatars/{file}.
-- storage.foldername(name) returns the path's folder segments (excluding
-- the filename itself), so foldername[1..4] here are
-- ('organizations', '{org_id}', 'users', '{user_id}').
create policy avatars_insert_own_prefix on storage.objects
for insert to authenticated
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = 'organizations'
  and (storage.foldername(name))[2] = (
    select organization_id::text from public."MST_User" where id = auth.uid()
  )
  and (storage.foldername(name))[3] = 'users'
  and (storage.foldername(name))[4] = auth.uid()::text
  and (storage.foldername(name))[5] = 'avatars'
);

create policy avatars_update_own_prefix on storage.objects
for update to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[4] = auth.uid()::text
)
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[4] = auth.uid()::text
);

create policy avatars_delete_own_prefix on storage.objects
for delete to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[4] = auth.uid()::text
);

-- Public bucket: readable by anyone (matches "avatars public bucket" in
-- SPEC §2 — avatars are shown across the org's UI, not access-restricted).
create policy avatars_select_public on storage.objects
for select to public
using (bucket_id = 'avatars');
