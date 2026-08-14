-- SPEC.md M2: auth, invitations, MFA. See the M2 implementation notes added
-- to SPEC.md §4/§7 for the architectural deviations explained inline below.

alter table public."MST_User"
  add column pending_aal2_grant_at timestamptz;

comment on column public."MST_User".pending_aal2_grant_at is
  'Short-lived marker (SPEC §7): set by verify_backup_code() on success, '
  'consumed by custom_access_token_hook() on the next token mint to grant '
  'aal2 for a session that used a backup code instead of TOTP.';

-- LOGIN_FAILED/LOGIN_LOCKOUT happen pre-auth against a bare email, before
-- any organization is resolvable (the email may not even belong to a real
-- user) — organization_id must be nullable to log those. Admins see
-- org-less rows too (they're not another org's private data, just
-- unattributed system events).
alter table public."AUD_SystemLog" alter column organization_id drop not null;

drop policy aud_systemlog_select_admin on public."AUD_SystemLog";

create policy aud_systemlog_select_admin on public."AUD_SystemLog"
  for select to authenticated
  using (
    private.app_user_role() = 'admin'
    and (organization_id = private.app_user_org_id() or organization_id is null)
  );

-- ---------------------------------------------------------------------
-- Password policy (SPEC §7): >=10 chars, >=1 letter, >=1 number.
-- ---------------------------------------------------------------------

create or replace function private.validate_password_policy(p_password text)
returns boolean
language sql
immutable
as $$
  select length(p_password) >= 10
    and p_password ~ '[A-Za-z]'
    and p_password ~ '[0-9]';
$$;

-- ---------------------------------------------------------------------
-- aal2-gated write guards (SPEC §3.2 "MFA gate"). RAISE the specific code
-- so RPC bodies get UNAUTHORIZED vs MFA_REQUIRED right without repeating
-- the three-way check everywhere.
-- ---------------------------------------------------------------------

create or replace function private.require_admin_write()
returns void
language plpgsql
stable
as $$
begin
  if private.app_user_role() is distinct from 'admin' or not private.app_role_is_current() then
    raise exception 'UNAUTHORIZED';
  end if;
  if not private.app_is_aal2() then
    raise exception 'MFA_REQUIRED';
  end if;
end;
$$;

create or replace function private.require_manager_or_admin_write()
returns void
language plpgsql
stable
as $$
begin
  if private.app_user_role() not in ('manager', 'admin') or not private.app_role_is_current() then
    raise exception 'UNAUTHORIZED';
  end if;
  if not private.app_is_aal2() then
    raise exception 'MFA_REQUIRED';
  end if;
end;
$$;

revoke execute on function private.require_admin_write from authenticated, anon, public;
revoke execute on function private.require_manager_or_admin_write from authenticated, anon, public;

-- ---------------------------------------------------------------------
-- Login lockout (SPEC §6/§7): 5/15min, email-keyed. Sign-in itself goes
-- through Supabase Auth's own SDK (not a Postgres RPC), so the client calls
-- check_login_allowed() first, and record_login_failure() after a failed
-- signInWithPassword call, to keep the "rate-limit checked first" invariant
-- for a flow that isn't itself an RPC.
-- ---------------------------------------------------------------------

create or replace function public.check_login_allowed(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public."RTL_RateLimitEvent"
  where bucket_key = 'login:' || lower(p_email)
    and created_at > (now() - interval '15 minutes');

  if v_count >= 5 then
    raise exception 'ERR_RATE_LIMITED';
  end if;
end;
$$;

create or replace function public.record_login_failure(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public."RTL_RateLimitEvent" (bucket_key) values ('login:' || lower(p_email));

  select count(*) into v_count
  from public."RTL_RateLimitEvent"
  where bucket_key = 'login:' || lower(p_email)
    and created_at > (now() - interval '15 minutes');

  perform private.log_audit_event(null, null, null, 'LOGIN_FAILED', null, jsonb_build_object('email', p_email));

  if v_count >= 5 then
    perform private.log_audit_event(null, null, null, 'LOGIN_LOCKOUT', null, jsonb_build_object('email', p_email));
  end if;
end;
$$;

revoke execute on function public.check_login_allowed from public;
revoke execute on function public.record_login_failure from public;
grant execute on function public.check_login_allowed to anon, authenticated;
grant execute on function public.record_login_failure to anon, authenticated;

-- ---------------------------------------------------------------------
-- accept_invitation (SPEC §4). Implementation deviation from the SPEC
-- table's "pre-auth (anon key)": invites are sent via
-- auth.admin.inviteUserByEmail (CLAUDE.md: Auth email goes through
-- Supabase Auth's built-in mailer only, and that's the only mailer-trigger
-- available to us), which creates the auth.users row and authenticates the
-- browser the moment the emailed link is clicked. So by the time a user
-- reaches /invite/{token}, they already have a session — this RPC runs
-- authenticated, sets their real password directly via pgcrypto (bcrypt,
-- format-compatible with GoTrue's own password checks), and provisions
-- their MST_User row. See SPEC.md's M2 note for the full reasoning.
-- ---------------------------------------------------------------------

create or replace function public.accept_invitation(
  p_token text,
  p_password text,
  p_first_name text,
  p_last_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invitation record;
  v_rate_ok boolean;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  v_rate_ok := private.check_rate_limit('invitation_accept:' || p_token, 10, interval '10 minutes');
  if not v_rate_ok then
    perform private.log_audit_event(null, v_user_id, null, 'RATE_LIMIT_TRIGGERED', null, null);
    raise exception 'ERR_RATE_LIMITED';
  end if;

  select * into v_invitation from public."MST_UserInvitation" where token = p_token;

  if v_invitation is null then
    raise exception 'INVITATION_NOT_FOUND';
  end if;
  if v_invitation.is_used then
    raise exception 'INVITATION_ALREADY_USED';
  end if;
  if v_invitation.revoked_at is not null then
    raise exception 'INVITATION_REVOKED';
  end if;
  if v_invitation.expires_at < now() then
    raise exception 'INVITATION_EXPIRED';
  end if;
  if not private.validate_password_policy(p_password) then
    raise exception 'PASSWORD_POLICY_VIOLATION';
  end if;

  update auth.users
    set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
        email_confirmed_at = coalesce(email_confirmed_at, now())
    where id = v_user_id;

  -- Guard against a double-accept race: only the first concurrent caller
  -- flips is_used, matching CORRECTION_ALREADY_RESOLVED's pattern elsewhere.
  update public."MST_UserInvitation"
    set is_used = true
    where id = v_invitation.id and is_used = false;

  if not found then
    raise exception 'INVITATION_ALREADY_USED';
  end if;

  insert into public."MST_User" (id, organization_id, first_name, last_name, role, is_active, mfa_enrolled)
  values (v_user_id, v_invitation.organization_id, p_first_name, p_last_name, v_invitation.role, true, false);

  perform private.log_audit_event(
    v_invitation.organization_id, v_user_id, v_user_id, 'INVITATION_ACCEPTED', null,
    jsonb_build_object('invitation_id', v_invitation.id)
  );
end;
$$;

revoke execute on function public.accept_invitation from public, anon;
grant execute on function public.accept_invitation to authenticated;

-- ---------------------------------------------------------------------
-- Admin invitation management (SPEC M2 checklist). create_invitation does
-- the DB-side work only; the /api/admin/invitations Route Handler calls
-- this (via the admin's own session, so the aal2 guard is real) and then
-- separately triggers auth.admin.inviteUserByEmail with the returned
-- token embedded in the redirect URL (SPEC §2.2: Route Handlers hold the
-- service-role key, RPCs stay the authorization boundary).
-- ---------------------------------------------------------------------

create or replace function public.create_invitation(p_email text, p_role text)
returns table (invitation_id uuid, invitation_token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_actor_id uuid := auth.uid();
  v_new_id uuid;
  v_new_token text;
begin
  perform private.require_admin_write();

  if p_role not in ('employee', 'manager', 'admin') then
    raise exception 'ERR_VALIDATION';
  end if;

  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  insert into public."MST_UserInvitation" (organization_id, email, role, invited_by)
  values (v_org_id, lower(p_email), p_role, v_actor_id)
  returning id, token into v_new_id, v_new_token;

  perform private.log_audit_event(v_org_id, v_actor_id, v_new_id, 'INVITATION_CREATED', null,
    jsonb_build_object('email', p_email, 'role', p_role));

  return query select v_new_id, v_new_token;
end;
$$;

create or replace function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_actor_id uuid := auth.uid();
begin
  perform private.require_admin_write();

  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  update public."MST_UserInvitation"
    set revoked_at = now(), revoked_by = v_actor_id
    where id = p_invitation_id and organization_id = v_org_id and is_used = false;

  if not found then
    raise exception 'INVITATION_NOT_FOUND';
  end if;

  perform private.log_audit_event(v_org_id, v_actor_id, p_invitation_id, 'INVITATION_REVOKED', null, null);
end;
$$;

revoke execute on function public.create_invitation from public, anon;
revoke execute on function public.revoke_invitation from public, anon;
grant execute on function public.create_invitation to authenticated;
grant execute on function public.revoke_invitation to authenticated;

-- ---------------------------------------------------------------------
-- MFA: TOTP enrollment happens client-side via the native Supabase Auth
-- SDK (auth.mfa.enroll/challenge/verify) — no custom RPC needed for that
-- part. Backup codes are custom (Supabase Auth has no native backup-code
-- factor type), generated only once TOTP verification has just succeeded
-- (checked via the caller already being aal2).
-- ---------------------------------------------------------------------

create or replace function public.generate_mfa_backup_codes()
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_codes text[] := array[]::text[];
  v_code text;
  i integer;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;
  if not private.app_is_aal2() then
    raise exception 'MFA_REQUIRED';
  end if;

  select organization_id into v_org_id from public."MST_User" where id = v_user_id;

  delete from public."MST_MfaBackupCode" where user_id = v_user_id and is_used = false;

  for i in 1..8 loop
    v_code := upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 10));
    v_codes := array_append(v_codes, v_code);
    insert into public."MST_MfaBackupCode" (organization_id, user_id, code_hash)
    values (v_org_id, v_user_id, extensions.crypt(v_code, extensions.gen_salt('bf')));
  end loop;

  update public."MST_User" set mfa_enrolled = true where id = v_user_id;

  perform private.log_audit_event(v_org_id, v_user_id, v_user_id, 'MFA_ENROLLED', null, null);

  return v_codes;
end;
$$;

-- SPEC §7: "backup-code use grants aal2 then forces re-enrollment". This
-- can't call the native TOTP verify path (no TOTP code available), so it
-- sets pending_aal2_grant_at; custom_access_token_hook consumes that marker
-- on the next token mint to stamp aal2 for this one grant.
create or replace function public.verify_backup_code(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_match_id uuid;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select organization_id into v_org_id from public."MST_User" where id = v_user_id;

  select id into v_match_id
    from public."MST_MfaBackupCode"
    where user_id = v_user_id
      and is_used = false
      and code_hash = extensions.crypt(p_code, code_hash)
    limit 1;

  if v_match_id is null then
    raise exception 'INVALID_MFA_CODE';
  end if;

  update public."MST_MfaBackupCode" set is_used = true, used_at = now() where id = v_match_id;
  update public."MST_User" set pending_aal2_grant_at = now(), mfa_enrolled = false where id = v_user_id;

  perform private.log_audit_event(v_org_id, v_user_id, v_user_id, 'MFA_ENROLLED', null,
    jsonb_build_object('via', 'backup_code_forced_reenroll'));
end;
$$;

create or replace function public.admin_reset_mfa(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_actor_id uuid := auth.uid();
begin
  perform private.require_admin_write();

  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  update public."MST_User"
    set mfa_enrolled = false, pending_aal2_grant_at = null
    where id = p_user_id and organization_id = v_org_id;

  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  delete from public."MST_MfaBackupCode" where user_id = p_user_id;

  perform private.log_audit_event(v_org_id, v_actor_id, p_user_id, 'MFA_RESET', null, null);
end;
$$;

revoke execute on function public.generate_mfa_backup_codes from public, anon;
revoke execute on function public.verify_backup_code from public, anon;
revoke execute on function public.admin_reset_mfa from public, anon;
grant execute on function public.generate_mfa_backup_codes to authenticated;
grant execute on function public.verify_backup_code to authenticated;
grant execute on function public.admin_reset_mfa to authenticated;

-- ---------------------------------------------------------------------
-- change_user_role / terminate_user (SPEC §4, §7, §14.6). DB-side only;
-- the /api/admin/* Route Handlers additionally force sign-out via the
-- Admin API after calling these (SPEC §2.2).
-- ---------------------------------------------------------------------

create or replace function public.change_user_role(p_user_id uuid, p_new_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_actor_id uuid := auth.uid();
  v_previous_role text;
begin
  perform private.require_admin_write();

  if p_new_role not in ('employee', 'manager', 'admin') then
    raise exception 'ERR_VALIDATION';
  end if;

  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  select role into v_previous_role
    from public."MST_User" where id = p_user_id and organization_id = v_org_id;

  if v_previous_role is null then
    raise exception 'USER_NOT_FOUND';
  end if;

  update public."MST_User"
    set role = p_new_role, role_changed_at = now()
    where id = p_user_id;

  -- SPEC §14.6: forces target re-login. role_changed_at staleness already
  -- blocks privileged writes from an old token; deleting the session makes
  -- ordinary access stop working too, immediately rather than at next expiry.
  delete from auth.sessions where user_id = p_user_id;

  perform private.log_audit_event(v_org_id, v_actor_id, p_user_id, 'USER_ROLE_CHANGED',
    jsonb_build_object('role', v_previous_role), jsonb_build_object('role', p_new_role));
end;
$$;

create or replace function public.terminate_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_actor_id uuid := auth.uid();
  v_retention_days integer;
begin
  perform private.require_admin_write();

  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;
  select data_retention_days into v_retention_days
    from public."MST_Organization" where id = v_org_id;

  update public."MST_User"
    set is_active = false,
        terminated_at = now(),
        scheduled_purge_at = now() + make_interval(days => v_retention_days)
    where id = p_user_id and organization_id = v_org_id;

  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  delete from auth.sessions where user_id = p_user_id;

  perform private.log_audit_event(v_org_id, v_actor_id, p_user_id, 'USER_TERMINATED', null, null);
end;
$$;

revoke execute on function public.change_user_role from public, anon;
revoke execute on function public.terminate_user from public, anon;
grant execute on function public.change_user_role to authenticated;
grant execute on function public.terminate_user to authenticated;

-- ---------------------------------------------------------------------
-- custom_access_token_hook: extend to also honor pending_aal2_grant_at
-- (single-use, 2-minute window) so the backup-code path can grant aal2.
-- ---------------------------------------------------------------------

-- volatile (not stable): the pending_aal2_grant_at consumption path below
-- performs an UPDATE, which a stable function isn't allowed to do.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claims jsonb;
  profile record;
  v_user_id uuid := (event ->> 'user_id')::uuid;
begin
  claims := event -> 'claims';

  select organization_id, role, role_changed_at, pending_aal2_grant_at
    into profile
    from public."MST_User"
    where id = v_user_id;

  if profile is null then
    return event;
  end if;

  claims := jsonb_set(claims, '{organization_id}', to_jsonb(profile.organization_id::text));
  claims := jsonb_set(claims, '{user_role}', to_jsonb(profile.role));
  claims := jsonb_set(claims, '{role_changed_at}', to_jsonb(profile.role_changed_at));

  if profile.pending_aal2_grant_at is not null and profile.pending_aal2_grant_at > (now() - interval '2 minutes') then
    claims := jsonb_set(claims, '{aal}', to_jsonb('aal2'::text));
    update public."MST_User" set pending_aal2_grant_at = null where id = v_user_id;
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- ---------------------------------------------------------------------
-- Forgot-password (SPEC §6/§7): 3/60min, email-keyed. Password reset
-- itself goes through Supabase Auth's native resetPasswordForEmail (not
-- an RPC), so the client checks this first, same pattern as login lockout.
-- ---------------------------------------------------------------------

create or replace function public.check_password_reset_allowed(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  v_ok := private.check_rate_limit('password_reset_request:' || lower(p_email), 3, interval '60 minutes');
  if not v_ok then
    perform private.log_audit_event(null, null, null, 'RATE_LIMIT_TRIGGERED', null, jsonb_build_object('email', p_email));
    raise exception 'ERR_RATE_LIMITED';
  end if;
end;
$$;

revoke execute on function public.check_password_reset_allowed from public;
grant execute on function public.check_password_reset_allowed to anon, authenticated;

-- Called right after auth.updateUser({password}) succeeds on the
-- /reset-password landing page. Revokes every OTHER session for this user
-- (SPEC §7 "revoke-all-sessions on completion"), keeping the current one
-- alive so the user isn't immediately logged back out.
create or replace function public.complete_password_reset()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_current_session_id uuid;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  v_current_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;

  delete from auth.sessions
    where user_id = v_user_id
      and (v_current_session_id is null or id <> v_current_session_id);
end;
$$;

revoke execute on function public.complete_password_reset from public, anon;
grant execute on function public.complete_password_reset to authenticated;
