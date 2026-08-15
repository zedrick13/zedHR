-- M8 rate-limit sweep: fixes two real bugs found while writing trip tests
-- for SPEC.md §6's buckets, not hypotheticals.
--
-- Bug 1 (audit trail): every guarded RPC does `perform
-- private.log_audit_event(..., 'RATE_LIMIT_TRIGGERED', ...); raise
-- exception 'ERR_RATE_LIMITED';` in the SAME function invocation. PostgREST
-- wraps each RPC call in one transaction; an uncaught RAISE EXCEPTION rolls
-- back everything done earlier in that same transaction — including the
-- audit-log INSERT that ran a moment before. Confirmed directly with a
-- throwaway probe function (insert, then raise, in one call): the insert
-- never persisted. RATE_LIMIT_TRIGGERED had never actually been recorded
-- for any of these RPCs, in contradiction of CLAUDE.md invariant #8
-- ("Breaches log RATE_LIMIT_TRIGGERED") and SPEC.md §6.
--
-- Bug 2 (the limit itself, more serious): `private.check_rate_limit()`'s
-- own COUNTING insert into RTL_RateLimitEvent has the exact same rollback
-- exposure. It's usually masked because most guarded RPCs succeed far more
-- often than they fail once past the rate check. accept_invitation exposed
-- it directly: every call in the sweep test used a bogus token, which
-- ALWAYS raises INVITATION_NOT_FOUND after the rate-limit check passes —
-- so the counting insert was rolled back every single time, and 11 calls
-- never tripped a 10/10min limit at all. That's a real gap: an attacker
-- brute-forcing invitation tokens (or any other guarded RPC's input, if
-- their attempts reliably fail validation after the counter increment)
-- gets effectively unlimited attempts, because a failed guess erases its
-- own counter row along with the rest of that transaction. Login lockout's
-- LOGIN_LOCKOUT/counting rows were never at risk of either bug — they're
-- written inside record_login_failure(), a call that itself returns
-- successfully (a separate, later check_login_allowed() call is the one
-- that raises).
--
-- The fix for both: an insert that must survive the caller's own
-- transaction aborting needs its own, independent transaction — Postgres
-- has no autonomous-transaction primitive without an extension. dblink
-- (standard Postgres contrib, already available in this image) opens a
-- real second connection; dblink_exec's statement commits immediately on
-- that connection regardless of what happens afterward on the original
-- one. A dedicated role with INSERT-only access to RTL_RateLimitEvent and
-- AUD_SystemLog (via BYPASSRLS, since neither table has an insert policy
-- for any client-facing role — only check_rate_limit()/log_audit_event(),
-- running as their SECURITY DEFINER owner, can normally write to them)
-- keeps this role's blast radius to "can write these two kinds of system
-- rows," nothing else; it is never granted to anon/authenticated and is
-- unreachable via PostgREST.
--
-- Caveats, flagged rather than assumed:
-- 1. Verified end-to-end against local Supabase, whose dev pg_hba.conf
--    trusts 127.0.0.1 outright — dblink refuses a supplied password
--    against an auth method that would ignore it (confirmed directly: the
--    identical dblink_exec call failed via 127.0.0.1, succeeded
--    immediately via the container's real Docker network address, which
--    hits a scram-sha-256 rule). The connection host is therefore
--    inet_server_addr() — whatever address THIS call's own connection
--    actually came in on — never a hardcoded loopback literal, so it
--    naturally resolves to a real routable address for any real
--    PostgREST-driven call. A real hosted Supabase project's internal
--    network/auth posture for this kind of loopback hasn't been confirmed
--    and needs a real pass before launch (SPEC.md §11).
-- 2. `alter database ... set app.*` was tried first for storing the
--    writer role's password and failed ("permission denied to set
--    parameter") — Supabase deliberately narrows the postgres role below
--    true superuser even locally, matching the hosted platform's model.
--    A private-schema table (below) needs no such privilege.

create extension if not exists dblink with schema extensions;

create table if not exists private.__internal_secret (
  key text primary key,
  value text not null
);
revoke all on private.__internal_secret from public, anon, authenticated, service_role;

do $$
declare
  v_password text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not exists (select 1 from pg_roles where rolname = 'rate_limit_writer') then
    execute format('create role rate_limit_writer login password %L bypassrls', v_password);
  else
    execute format('alter role rate_limit_writer password %L', v_password);
  end if;

  insert into private.__internal_secret (key, value)
  values ('rate_limit_writer_password', v_password)
  on conflict (key) do update set value = excluded.value;
end $$;

revoke all on public."AUD_SystemLog" from rate_limit_writer;
grant insert on public."AUD_SystemLog" to rate_limit_writer;
revoke all on public."RTL_RateLimitEvent" from rate_limit_writer;
grant insert on public."RTL_RateLimitEvent" to rate_limit_writer;

-- Shared by both check_rate_limit's counting insert and
-- log_rate_limit_breach's audit insert below — opens the loopback
-- connection and runs one autonomous, already-fully-formed INSERT
-- statement. Best-effort: if the writer credential isn't configured, or
-- the connection/insert fails for any reason, this returns silently
-- rather than raising — the caller's actual request (already decided by
-- check_rate_limit's return value) must never fail because of this
-- plumbing.
create or replace function private.__autonomous_insert(p_sql text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_password text;
  v_conn text;
begin
  select value into v_password from private.__internal_secret where key = 'rate_limit_writer_password';
  if v_password is null then
    return;
  end if;

  -- host(inet_server_addr()) strips the /32 CIDR suffix inet's ::text cast
  -- otherwise leaves in place, which libpq's "host=" parameter doesn't
  -- accept (confirmed directly: dblink_exec failed with "could not
  -- translate host name 172.18.0.10/32" until this was added). Falls back
  -- to loopback only for the rare Unix-socket-connected caller, where
  -- inet_server_addr() is null.
  v_conn := format(
    'host=%s dbname=%s user=rate_limit_writer password=%s',
    coalesce(host(inet_server_addr()), '127.0.0.1'), current_database(), v_password
  );

  perform extensions.dblink_exec(v_conn, p_sql);
exception
  when others then
    null;
end;
$$;

revoke execute on function private.__autonomous_insert from public;

-- Re-created with the counting insert on the true/success path routed
-- through private.__autonomous_insert(...) instead of a plain local
-- insert (Bug 2 above) — everything else is unchanged from the live
-- definition.
create or replace function private.check_rate_limit(
  p_bucket_key text,
  p_max_count integer,
  p_window interval,
  p_user_id uuid default null,
  p_organization_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public."RTL_RateLimitEvent"
  where bucket_key = p_bucket_key
    and created_at > (now() - p_window);

  if v_count >= p_max_count then
    return false;
  end if;

  perform private.__autonomous_insert(
    format(
      'insert into public.%I (organization_id, user_id, bucket_key) values (%L, %L, %L)',
      'RTL_RateLimitEvent', p_organization_id, p_user_id, p_bucket_key
    )
  );

  return true;
end;
$$;

create or replace function private.log_rate_limit_breach(
  p_organization_id uuid,
  p_actor_id uuid,
  p_target_id uuid,
  p_details jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform private.__autonomous_insert(
    format(
      'insert into public.%I (organization_id, actor_id, target_id, action_type, new_value) values (%L, %L, %L, %L, %L)',
      'AUD_SystemLog', p_organization_id, p_actor_id, p_target_id, 'RATE_LIMIT_TRIGGERED', p_details
    )
  );
end;
$$;

revoke execute on function private.log_rate_limit_breach from public;

-- The 11 RPCs below are re-created with their rate-limit-breach branch
-- calling private.log_rate_limit_breach(...) instead of
-- private.log_audit_event(...) — everything else in each function body is
-- byte-for-byte unchanged from its live definition (pulled directly via
-- pg_get_functiondef before editing, not retyped from the original
-- migration files, to avoid transcription drift).

CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text, p_password text, p_first_name text, p_last_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    perform private.log_rate_limit_breach(null, v_user_id, null, null);
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
$function$;

CREATE OR REPLACE FUNCTION public.check_password_reset_allowed(p_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ok boolean;
begin
  v_ok := private.check_rate_limit('password_reset_request:' || lower(p_email), 3, interval '60 minutes');
  if not v_ok then
    perform private.log_rate_limit_breach(null, null, null, jsonb_build_object('email', p_email));
    raise exception 'ERR_RATE_LIMITED';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.clock_in_user(p_lat double precision, p_lng double precision, p_geo_status text, p_attempted_timestamp timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_duration_seconds integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_dept_id uuid;
  v_employee_name text;
  v_effective_arrangement text;
  v_org record;
  v_outside boolean := false;
  v_session_id uuid;
  v_lat double precision;
  v_lng double precision;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select organization_id, department_id, first_name || ' ' || last_name
    into v_org_id, v_dept_id, v_employee_name
    from public."MST_User" where id = v_user_id;

  if not private.check_rate_limit('clock_action:' || v_user_id, 10, interval '60 seconds', v_user_id, v_org_id) then
    perform private.log_rate_limit_breach(v_org_id, v_user_id, v_user_id, null);
    raise exception 'ERR_RATE_LIMITED';
  end if;

  if p_geo_status not in ('checked', 'unavailable', 'denied') then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_geo_status = 'checked' and (p_lat is null or p_lng is null) then
    raise exception 'ERR_VALIDATION';
  end if;

  if p_geo_status = 'checked' then
    v_lat := p_lat;
    v_lng := p_lng;
  else
    v_lat := null;
    v_lng := null;
  end if;

  -- Fast-path check (idx_open_work_session is the real, race-safe guarantee
  -- — see the exception handler below).
  if exists (
    select 1 from public."TIM_WorkSession" where user_id = v_user_id and clock_out_time is null
  ) then
    raise exception 'USER_ALREADY_CLOCKED_IN';
  end if;

  v_effective_arrangement := private.resolve_work_arrangement(v_user_id, v_dept_id, v_org_id, current_date);
  if v_effective_arrangement = 'hybrid' then
    v_effective_arrangement := 'office';
  end if;

  if p_geo_status = 'checked' and v_effective_arrangement = 'office' then
    select geofence_latitude, geofence_longitude, geofence_radius_m into v_org
      from public."MST_Organization" where id = v_org_id;
    if v_org.geofence_latitude is not null and v_org.geofence_longitude is not null
       and v_org.geofence_radius_m is not null then
      if private.haversine_distance_m(v_lat, v_lng, v_org.geofence_latitude, v_org.geofence_longitude)
         > v_org.geofence_radius_m then
        v_outside := true;
      end if;
    end if;
  end if;

  begin
    insert into public."TIM_WorkSession" (
      user_id, organization_id, clock_in_time, clock_in_ip, clock_in_geo_status,
      clock_in_lat, clock_in_lng, clock_in_outside_boundary
    ) values (
      v_user_id, v_org_id, now(), inet_client_addr(), p_geo_status, v_lat, v_lng, v_outside
    )
    returning id into v_session_id;
  exception
    when unique_violation then
      raise exception 'USER_ALREADY_CLOCKED_IN';
  end;

  perform private.log_audit_event(v_org_id, v_user_id, v_session_id, 'CLOCK_IN', null,
    jsonb_build_object('geo_status', p_geo_status, 'outside_boundary', v_outside));

  if v_outside then
    perform private.notify_geofence_breach(v_org_id, v_dept_id, v_user_id, v_employee_name);
  end if;

  perform private.check_and_log_drift(
    v_user_id, v_org_id, 'clock_in', p_attempted_timestamp, p_offline_duration_seconds
  );

  return v_session_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.clock_out_user(p_lat double precision, p_lng double precision, p_geo_status text, p_attempted_timestamp timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_duration_seconds integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_dept_id uuid;
  v_employee_name text;
  v_effective_arrangement text;
  v_org record;
  v_outside boolean := false;
  v_session record;
  v_lat double precision;
  v_lng double precision;
  v_open_cb record;
  v_open_lb record;
  v_duration_minutes numeric;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select organization_id, department_id, first_name || ' ' || last_name
    into v_org_id, v_dept_id, v_employee_name
    from public."MST_User" where id = v_user_id;

  if not private.check_rate_limit('clock_action:' || v_user_id, 10, interval '60 seconds', v_user_id, v_org_id) then
    perform private.log_rate_limit_breach(v_org_id, v_user_id, v_user_id, null);
    raise exception 'ERR_RATE_LIMITED';
  end if;

  if p_geo_status not in ('checked', 'unavailable', 'denied') then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_geo_status = 'checked' and (p_lat is null or p_lng is null) then
    raise exception 'ERR_VALIDATION';
  end if;

  select * into v_session from public."TIM_WorkSession"
    where user_id = v_user_id and clock_out_time is null
    limit 1;

  if v_session is null then
    raise exception 'NO_ACTIVE_SESSION';
  end if;

  if p_geo_status = 'checked' then
    v_lat := p_lat;
    v_lng := p_lng;
  else
    v_lat := null;
    v_lng := null;
  end if;

  v_effective_arrangement := private.resolve_work_arrangement(v_user_id, v_dept_id, v_org_id, current_date);
  if v_effective_arrangement = 'hybrid' then
    v_effective_arrangement := 'office';
  end if;

  select geofence_latitude, geofence_longitude, geofence_radius_m into v_org
    from public."MST_Organization" where id = v_org_id;

  if p_geo_status = 'checked' and v_effective_arrangement = 'office'
     and v_org.geofence_latitude is not null and v_org.geofence_longitude is not null
     and v_org.geofence_radius_m is not null then
    if private.haversine_distance_m(v_lat, v_lng, v_org.geofence_latitude, v_org.geofence_longitude)
       > v_org.geofence_radius_m then
      v_outside := true;
    end if;
  end if;

  -- Force-close any open break (SPEC §4 "Key behaviors"): is_auto_closed,
  -- evaluate the same violation math used by end_cb/end_lb.
  --
  -- NOTE: `record_var IS NOT NULL` is unreliable in PL/pgSQL for a plain
  -- `record`-typed variable — it evaluates false even when a row was found
  -- (confirmed: `record_var IS NULL` alone is correct in both directions,
  -- but the negated form isn't). `NOT (... IS NULL)` is the reliable
  -- equivalent used throughout this file and the break/state RPCs.
  select * into v_open_cb from public."TIM_CompensableBreak"
    where work_session_id = v_session.id and end_time is null limit 1;
  if not (v_open_cb is null) then
    v_duration_minutes := extract(epoch from (now() - v_open_cb.start_time)) / 60;
    update public."TIM_CompensableBreak"
      set end_time = now(),
          is_auto_closed = true,
          policy_violation = v_duration_minutes > (
            select max_cb_minutes from public."MST_Organization" where id = v_org_id
          ),
          policy_violation_reason = case
            when v_duration_minutes > (select max_cb_minutes from public."MST_Organization" where id = v_org_id)
            then 'CB_OVERTIME'
            else null
          end
      where id = v_open_cb.id;
    perform private.log_audit_event(v_org_id, v_user_id, v_open_cb.id, 'CB_ENDED', null,
      jsonb_build_object('is_auto_closed', true));
  end if;

  select * into v_open_lb from public."TIM_NonCompensableBreak"
    where work_session_id = v_session.id and end_time is null limit 1;
  if not (v_open_lb is null) then
    -- Abandoned LB never gets LB_SHORT (SPEC §8.2) — it's short because it
    -- was force-closed, not because the employee under-took their break.
    update public."TIM_NonCompensableBreak"
      set end_time = now(), is_auto_closed = true
      where id = v_open_lb.id;
    perform private.log_audit_event(v_org_id, v_user_id, v_open_lb.id, 'LB_ENDED', null,
      jsonb_build_object('is_auto_closed', true));
  end if;

  update public."TIM_WorkSession"
    set clock_out_time = now(),
        clock_out_ip = inet_client_addr(),
        clock_out_geo_status = p_geo_status,
        clock_out_lat = v_lat,
        clock_out_lng = v_lng,
        clock_out_outside_boundary = v_outside
    where id = v_session.id;

  perform private.log_audit_event(v_org_id, v_user_id, v_session.id, 'CLOCK_OUT', null,
    jsonb_build_object('geo_status', p_geo_status, 'outside_boundary', v_outside));

  if v_outside then
    perform private.notify_geofence_breach(v_org_id, v_dept_id, v_user_id, v_employee_name);
  end if;

  perform private.check_and_log_drift(
    v_user_id, v_org_id, 'clock_out', p_attempted_timestamp, p_offline_duration_seconds
  );

  return v_session.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.end_cb(p_attempted_timestamp timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_duration_seconds integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_session record;
  v_break record;
  v_duration_minutes numeric;
  v_max_cb integer;
  v_violation boolean;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;
  select organization_id into v_org_id from public."MST_User" where id = v_user_id;

  if not private.check_rate_limit('clock_action:' || v_user_id, 10, interval '60 seconds', v_user_id, v_org_id) then
    perform private.log_rate_limit_breach(v_org_id, v_user_id, v_user_id, null);
    raise exception 'ERR_RATE_LIMITED';
  end if;

  select * into v_session from public."TIM_WorkSession"
    where user_id = v_user_id and clock_out_time is null limit 1;
  if v_session is null then
    raise exception 'NO_ACTIVE_SESSION';
  end if;

  select * into v_break from public."TIM_CompensableBreak"
    where work_session_id = v_session.id and end_time is null limit 1;
  if v_break is null then
    raise exception 'NO_ACTIVE_BREAK';
  end if;

  select max_cb_minutes into v_max_cb from public."MST_Organization" where id = v_org_id;
  v_duration_minutes := extract(epoch from (now() - v_break.start_time)) / 60;
  v_violation := v_duration_minutes > v_max_cb;

  update public."TIM_CompensableBreak"
    set end_time = now(),
        policy_violation = v_violation,
        policy_violation_reason = case when v_violation then 'CB_OVERTIME' else null end
    where id = v_break.id;

  perform private.log_audit_event(v_org_id, v_user_id, v_break.id, 'CB_ENDED', null,
    jsonb_build_object('policy_violation', v_violation));
  perform private.check_and_log_drift(
    v_user_id, v_org_id, 'end_cb', p_attempted_timestamp, p_offline_duration_seconds
  );

  return v_break.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.end_lb(p_attempted_timestamp timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_duration_seconds integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_session record;
  v_break record;
  v_duration_minutes numeric;
  v_min_lb integer;
  v_violation boolean;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;
  select organization_id into v_org_id from public."MST_User" where id = v_user_id;

  if not private.check_rate_limit('clock_action:' || v_user_id, 10, interval '60 seconds', v_user_id, v_org_id) then
    perform private.log_rate_limit_breach(v_org_id, v_user_id, v_user_id, null);
    raise exception 'ERR_RATE_LIMITED';
  end if;

  select * into v_session from public."TIM_WorkSession"
    where user_id = v_user_id and clock_out_time is null limit 1;
  if v_session is null then
    raise exception 'NO_ACTIVE_SESSION';
  end if;

  select * into v_break from public."TIM_NonCompensableBreak"
    where work_session_id = v_session.id and end_time is null limit 1;
  if v_break is null then
    raise exception 'NO_ACTIVE_BREAK';
  end if;

  select min_lb_minutes into v_min_lb from public."MST_Organization" where id = v_org_id;
  v_duration_minutes := extract(epoch from (now() - v_break.start_time)) / 60;
  v_violation := v_duration_minutes < v_min_lb;

  update public."TIM_NonCompensableBreak"
    set end_time = now(),
        policy_violation = v_violation,
        policy_violation_reason = case when v_violation then 'LB_SHORT' else null end
    where id = v_break.id;

  perform private.log_audit_event(v_org_id, v_user_id, v_break.id, 'LB_ENDED', null,
    jsonb_build_object('policy_violation', v_violation));
  perform private.check_and_log_drift(
    v_user_id, v_org_id, 'end_lb', p_attempted_timestamp, p_offline_duration_seconds
  );

  return v_break.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.export_timesheet_report(p_department_id uuid DEFAULT NULL::uuid, p_employee_id uuid DEFAULT NULL::uuid, p_range_start date DEFAULT NULL::date, p_range_end date DEFAULT NULL::date)
 RETURNS TABLE(employee_name text, department_name text, session_date text, clock_in text, clock_out text, duration_hours numeric, cb_minutes numeric, lb_minutes numeric, violations text, geofence text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor_id uuid := auth.uid();
  v_role text := private.app_user_role();
  v_org_id uuid := private.app_user_org_id();
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  if v_actor_id is null then
    raise exception 'UNAUTHORIZED';
  end if;
  if v_role not in ('manager', 'admin') then
    raise exception 'UNAUTHORIZED';
  end if;

  if not private.check_rate_limit('report_export:' || v_actor_id, 20, interval '1 hour', v_actor_id, v_org_id) then
    perform private.log_rate_limit_breach(v_org_id, v_actor_id, v_actor_id, null);
    raise exception 'ERR_RATE_LIMITED';
  end if;

  if p_department_id is not null and v_role = 'manager'
     and not exists (
       select 1 from public."MST_Department" where id = p_department_id and manager_id = v_actor_id
     )
  then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_employee_id is not null and v_role = 'manager' and not private.app_is_managing_user(p_employee_id) then
    raise exception 'UNAUTHORIZED';
  end if;

  select timezone into v_tz from public."MST_Organization" where id = v_org_id;

  if p_range_start is not null then
    v_start := p_range_start::timestamp at time zone v_tz;
  end if;
  if p_range_end is not null then
    v_end := (p_range_end + 1)::timestamp at time zone v_tz;
  end if;

  return query
  select
    u.first_name || ' ' || u.last_name as employee_name,
    d.name as department_name,
    to_char(ws.clock_in_time at time zone v_tz, 'YYYY-MM-DD') as session_date,
    to_char(ws.clock_in_time at time zone v_tz, 'HH24:MI') as clock_in,
    case when ws.clock_out_time is not null
      then to_char(ws.clock_out_time at time zone v_tz, 'HH24:MI')
      else null
    end as clock_out,
    round((extract(epoch from (coalesce(ws.clock_out_time, now()) - ws.clock_in_time)) / 3600.0)::numeric, 2)
      as duration_hours,
    round(coalesce(cb.total_minutes, 0)::numeric, 1) as cb_minutes,
    round(coalesce(lb.total_minutes, 0)::numeric, 1) as lb_minutes,
    nullif(concat_ws('; ', cb.violation_reasons, lb.violation_reasons), '') as violations,
    case
      when arr.effective_arrangement = 'wfh' then 'N/A (WFH)'
      when ws.clock_in_geo_status is distinct from 'checked' then 'N/A (No GPS)'
      when ws.clock_in_outside_boundary then 'Out of Bounds'
      else 'Ok'
    end as geofence
  from public."TIM_WorkSession" ws
  join public."MST_User" u on u.id = ws.user_id
  left join public."MST_Department" d on d.id = u.department_id
  left join lateral (
    select case
      when private.resolve_work_arrangement(
        u.id, u.department_id, v_org_id, (ws.clock_in_time at time zone v_tz)::date
      ) = 'wfh' then 'wfh'
      else 'office'
    end as effective_arrangement
  ) arr on true
  left join lateral (
    select
      sum(extract(epoch from (coalesce(end_time, now()) - start_time))) / 60 as total_minutes,
      string_agg(distinct policy_violation_reason, ', ') as violation_reasons
    from public."TIM_CompensableBreak"
    where work_session_id = ws.id
  ) cb on true
  left join lateral (
    select
      sum(extract(epoch from (coalesce(end_time, now()) - start_time))) / 60 as total_minutes,
      string_agg(distinct policy_violation_reason, ', ') as violation_reasons
    from public."TIM_NonCompensableBreak"
    where work_session_id = ws.id
  ) lb on true
  where u.organization_id = v_org_id
    and (v_start is null or ws.clock_in_time >= v_start)
    and (v_end is null or ws.clock_in_time < v_end)
    and (p_employee_id is null or u.id = p_employee_id)
    and (p_department_id is null or u.department_id = p_department_id)
    and (
      v_role = 'admin'
      or (
        v_role = 'manager'
        and u.department_id in (select id from public."MST_Department" where manager_id = v_actor_id)
      )
    )
  order by ws.clock_in_time;
end;
$function$;

CREATE OR REPLACE FUNCTION public.log_sync_conflict(p_failed_action text, p_details jsonb, p_work_session_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_dept_id uuid;
  v_employee_name text;
  v_manager_id uuid;
  v_admin_id uuid;
  v_conflict_id uuid;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select organization_id, department_id, first_name || ' ' || last_name
    into v_org_id, v_dept_id, v_employee_name
    from public."MST_User" where id = v_user_id;

  if not private.check_rate_limit('sync_conflict:' || v_user_id, 30, interval '1 hour', v_user_id, v_org_id) then
    perform private.log_rate_limit_breach(v_org_id, v_user_id, v_user_id, null);
    raise exception 'ERR_RATE_LIMITED';
  end if;

  if p_failed_action not in ('clock_in', 'clock_out', 'start_cb', 'end_cb', 'start_lb', 'end_lb') then
    raise exception 'ERR_VALIDATION';
  end if;

  insert into public."TIM_SyncConflict" (organization_id, user_id, work_session_id, failed_action, details)
  values (v_org_id, v_user_id, p_work_session_id, p_failed_action, coalesce(p_details, '{}'::jsonb))
  returning id into v_conflict_id;

  perform private.log_audit_event(v_org_id, v_user_id, v_conflict_id, 'SYNC_CONFLICT_LOGGED', null,
    jsonb_build_object('failed_action', p_failed_action));

  select manager_id into v_manager_id from public."MST_Department" where id = v_dept_id;

  if v_manager_id is not null then
    perform private.create_notification(v_org_id, v_manager_id, 'F',
      'Offline sync conflict',
      v_employee_name || '''s offline punch could not be synced automatically and needs review.',
      '/dashboard');
  else
    for v_admin_id in
      select id from public."MST_User" where organization_id = v_org_id and role = 'admin'
    loop
      perform private.create_notification(v_org_id, v_admin_id, 'F',
        'Offline sync conflict',
        v_employee_name || '''s offline punch could not be synced automatically and needs review.',
        '/dashboard');
    end loop;
  end if;

  return v_conflict_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.start_cb(p_attempted_timestamp timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_duration_seconds integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_session record;
  v_break_id uuid;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;
  select organization_id into v_org_id from public."MST_User" where id = v_user_id;

  if not private.check_rate_limit('clock_action:' || v_user_id, 10, interval '60 seconds', v_user_id, v_org_id) then
    perform private.log_rate_limit_breach(v_org_id, v_user_id, v_user_id, null);
    raise exception 'ERR_RATE_LIMITED';
  end if;

  select * into v_session from public."TIM_WorkSession"
    where user_id = v_user_id and clock_out_time is null limit 1;
  if v_session is null then
    raise exception 'NO_ACTIVE_SESSION';
  end if;

  if exists (select 1 from public."TIM_CompensableBreak" where work_session_id = v_session.id and end_time is null)
     or exists (select 1 from public."TIM_NonCompensableBreak" where work_session_id = v_session.id and end_time is null)
  then
    raise exception 'BREAK_ALREADY_OPEN';
  end if;

  begin
    insert into public."TIM_CompensableBreak" (organization_id, work_session_id, start_time)
    values (v_org_id, v_session.id, now())
    returning id into v_break_id;
  exception
    when unique_violation then
      raise exception 'BREAK_ALREADY_OPEN';
  end;

  perform private.log_audit_event(v_org_id, v_user_id, v_break_id, 'CB_STARTED', null, null);
  perform private.check_and_log_drift(
    v_user_id, v_org_id, 'start_cb', p_attempted_timestamp, p_offline_duration_seconds
  );
  return v_break_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.start_lb(p_attempted_timestamp timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_duration_seconds integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_session record;
  v_break_id uuid;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;
  select organization_id into v_org_id from public."MST_User" where id = v_user_id;

  if not private.check_rate_limit('clock_action:' || v_user_id, 10, interval '60 seconds', v_user_id, v_org_id) then
    perform private.log_rate_limit_breach(v_org_id, v_user_id, v_user_id, null);
    raise exception 'ERR_RATE_LIMITED';
  end if;

  select * into v_session from public."TIM_WorkSession"
    where user_id = v_user_id and clock_out_time is null limit 1;
  if v_session is null then
    raise exception 'NO_ACTIVE_SESSION';
  end if;

  if exists (select 1 from public."TIM_CompensableBreak" where work_session_id = v_session.id and end_time is null)
     or exists (select 1 from public."TIM_NonCompensableBreak" where work_session_id = v_session.id and end_time is null)
  then
    raise exception 'BREAK_ALREADY_OPEN';
  end if;

  begin
    insert into public."TIM_NonCompensableBreak" (organization_id, work_session_id, start_time)
    values (v_org_id, v_session.id, now())
    returning id into v_break_id;
  exception
    when unique_violation then
      raise exception 'BREAK_ALREADY_OPEN';
  end;

  perform private.log_audit_event(v_org_id, v_user_id, v_break_id, 'LB_STARTED', null, null);
  perform private.check_and_log_drift(
    v_user_id, v_org_id, 'start_lb', p_attempted_timestamp, p_offline_duration_seconds
  );
  return v_break_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_correction_request(p_work_session_id uuid, p_request_type text, p_requested_timestamp timestamp with time zone, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_dept_id uuid;
  v_manager_id uuid;
  v_correction_id uuid;
  v_employee_name text;
  v_admin_id uuid;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select organization_id, department_id, first_name || ' ' || last_name
    into v_org_id, v_dept_id, v_employee_name
    from public."MST_User" where id = v_user_id;

  if not private.check_rate_limit('correction_submit:' || v_user_id, 20, interval '24 hours', v_user_id, v_org_id) then
    perform private.log_rate_limit_breach(v_org_id, v_user_id, v_user_id, null);
    raise exception 'ERR_RATE_LIMITED';
  end if;

  if p_request_type not in ('clock_in', 'clock_out', 'cb_start', 'cb_end', 'lb_start', 'lb_end', 'create_session') then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_reason is null or char_length(p_reason) < 1 or char_length(p_reason) > 500 then
    raise exception 'ERR_VALIDATION';
  end if;
  -- Every request type except create_session must target an existing
  -- session the caller owns; create_session must NOT reference one yet.
  if p_request_type = 'create_session' then
    if p_work_session_id is not null then
      raise exception 'ERR_VALIDATION';
    end if;
  else
    if p_work_session_id is null
       or not exists (
         select 1 from public."TIM_WorkSession"
         where id = p_work_session_id and user_id = v_user_id
       )
    then
      raise exception 'ERR_VALIDATION';
    end if;
  end if;

  insert into public."TIM_CorrectionRequest" (
    user_id, organization_id, work_session_id, request_type, requested_timestamp, reason
  ) values (
    v_user_id, v_org_id, p_work_session_id, p_request_type, p_requested_timestamp, p_reason
  )
  returning id into v_correction_id;

  perform private.log_audit_event(v_org_id, v_user_id, v_correction_id, 'CORRECTION_SUBMITTED', null,
    jsonb_build_object('request_type', p_request_type));

  -- Template B: to the department's manager, or every admin if unmanaged.
  select manager_id into v_manager_id from public."MST_Department" where id = v_dept_id;

  if v_manager_id is not null then
    perform private.create_notification(v_org_id, v_manager_id, 'B',
      'New correction request',
      v_employee_name || ' submitted a timesheet correction request.',
      '/requests');
  else
    for v_admin_id in
      select id from public."MST_User" where organization_id = v_org_id and role = 'admin'
    loop
      perform private.create_notification(v_org_id, v_admin_id, 'B',
        'New correction request',
        v_employee_name || ' submitted a timesheet correction request.',
        '/requests');
    end loop;
  end if;

  return v_correction_id;
end;
$function$;
