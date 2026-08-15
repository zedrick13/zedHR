-- SPEC.md M7: after a successful direct-to-Storage upload (via the signed
-- URL the get_avatar_upload_url Edge Function mints), the client calls
-- this RPC to persist the final path on MST_User.avatar_path — RLS on
-- MST_User is SELECT-only for clients (CLAUDE.md invariant #2), so this
-- is the only way the column gets written. Re-validates the path's own
-- prefix server-side (defense in depth alongside the Storage RLS policies
-- that already restrict the upload itself to the same prefix) rather than
-- trusting whatever string the client sends. p_avatar_path may be null to
-- clear/remove the avatar.

create or replace function public.update_own_avatar_path(p_avatar_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_expected_prefix text;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select organization_id into v_org_id from public."MST_User" where id = v_user_id;
  v_expected_prefix := 'organizations/' || v_org_id || '/users/' || v_user_id || '/avatars/';

  if p_avatar_path is not null and left(p_avatar_path, char_length(v_expected_prefix)) <> v_expected_prefix then
    raise exception 'ERR_VALIDATION';
  end if;

  update public."MST_User" set avatar_path = p_avatar_path where id = v_user_id;
end;
$$;

revoke execute on function public.update_own_avatar_path from public, anon;
grant execute on function public.update_own_avatar_path to authenticated;
