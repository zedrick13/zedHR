-- SPEC.md M6: offline queue & sync.
--
-- Two closed lists get extended here (CLAUDE.md invariants #7/#9 sibling
-- rule: extending an enumerated list is a migration + SPEC.md update in the
-- same PR, never silent):
--   - NTF_Notification.template gains 'F' (sync conflict -> manager). SPEC
--     §4's template list runs A, B, C, D, E, G — the gap at F, with every
--     other letter already assigned a specific meaning, is the strongest
--     signal available that F was reserved for exactly this notification;
--     flagged in SPEC.md rather than silently assumed.
--   - AUD_SystemLog.action_type gains 'SYNC_CONFLICT_LOGGED' and
--     'SUSPICIOUS_DRIFT_DETECTED', both named directly in/implied by §8.1.
--
-- Client timestamps flow into the six punch RPCs as two new optional
-- params (p_attempted_timestamp, p_offline_duration_seconds), both null on
-- a live call and populated only by the offline sync worker — never stored
-- as the punch time itself (CLAUDE.md invariant #3 is unchanged: NOW() is
-- still what's written to clock_in_time/clock_out_time/etc.). They're used
-- only for the discounted-drift check below.

alter table public."NTF_Notification"
  drop constraint "NTF_Notification_template_check",
  add constraint "NTF_Notification_template_check" check (template in ('B', 'C', 'D', 'E', 'F', 'G'));

alter table public."AUD_SystemLog"
  drop constraint "AUD_SystemLog_action_type_check",
  add constraint "AUD_SystemLog_action_type_check" check (
    action_type in (
      'CLOCK_IN',
      'CLOCK_OUT',
      'CB_STARTED',
      'CB_ENDED',
      'LB_STARTED',
      'LB_ENDED',
      'CORRECTION_SUBMITTED',
      'CORRECTION_APPROVED',
      'CORRECTION_REJECTED',
      'TIMECARD_ADMIN_EDITED',
      'INVITATION_CREATED',
      'INVITATION_REVOKED',
      'INVITATION_ACCEPTED',
      'USER_TERMINATED',
      'USER_ANONYMIZED',
      'MFA_ENROLLED',
      'MFA_RESET',
      'USER_ROLE_CHANGED',
      'DSAR_REQUEST_LOGGED',
      'DSAR_REQUEST_FULFILLED',
      'LOGIN_FAILED',
      'LOGIN_LOCKOUT',
      'RATE_LIMIT_TRIGGERED',
      'SYNC_CONFLICT_LOGGED',
      'SUSPICIOUS_DRIFT_DETECTED'
    )
  );

-- ---------------------------------------------------------------------
-- Discounted drift check (SPEC §8.1: "Drift strictly > 5:00 vs server
-- NOW() (discounting offline period) ⇒ is_suspicious_drift log"). Called
-- internally by the punch RPCs below; not exposed to the client directly.
-- Uses abs() rather than the raw signed value — SPEC says "drift", which
-- reads as the magnitude of the discrepancy either direction (client clock
-- behind OR ahead), not only the behind-schedule case; flagged as an
-- interpretation in SPEC.md.
-- ---------------------------------------------------------------------

create or replace function private.check_and_log_drift(
  p_user_id uuid,
  p_org_id uuid,
  p_action text,
  p_attempted_timestamp timestamptz,
  p_offline_duration_seconds integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_discounted_drift_seconds numeric;
begin
  if p_attempted_timestamp is null or p_offline_duration_seconds is null then
    return;
  end if;

  v_discounted_drift_seconds := abs(
    extract(epoch from (now() - p_attempted_timestamp)) - p_offline_duration_seconds
  );

  if v_discounted_drift_seconds > 300 then
    perform private.log_audit_event(p_org_id, p_user_id, p_user_id, 'SUSPICIOUS_DRIFT_DETECTED', null,
      jsonb_build_object(
        'action', p_action,
        'attempted_timestamp', p_attempted_timestamp,
        'offline_duration_seconds', p_offline_duration_seconds,
        'discounted_drift_seconds', v_discounted_drift_seconds
      ));
  end if;
end;
$$;

revoke execute on function private.check_and_log_drift from authenticated, anon, public;

-- ---------------------------------------------------------------------
-- log_sync_conflict — called by the offline sync worker only, for a
-- queued action that failed with something other than its idempotent-
-- success code (SPEC §2.3/§8.1). Records the row, notifies the employee's
-- manager (or every admin if unmanaged — same fallback as Templates B/C),
-- and audits it. Rate-limited (CLAUDE.md invariant #8); SPEC gives no
-- specific threshold for this bucket, same placeholder-not-silent-default
-- status as report_export's (SPEC.md §11).
-- ---------------------------------------------------------------------

create or replace function public.log_sync_conflict(
  p_failed_action text,
  p_details jsonb,
  p_work_session_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
    perform private.log_audit_event(v_org_id, v_user_id, v_user_id, 'RATE_LIMIT_TRIGGERED', null, null);
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
$$;

revoke execute on function public.log_sync_conflict from public, anon;
grant execute on function public.log_sync_conflict to authenticated;

-- ---------------------------------------------------------------------
-- clock_in_user / clock_out_user: add the two offline-only params and a
-- drift check on success. Full bodies re-stated (same precedent as the M5
-- migration re-stating them for the Template C wiring) rather than
-- editing the M3/M5 files in place.
--
-- `create or replace function` only replaces a function with the EXACT
-- SAME parameter list — adding two new (even defaulted) params makes
-- Postgres treat it as a distinct overload, not a replacement, leaving the
-- old 3-arg version callable and ambiguous alongside it (confirmed by a
-- failed `db reset`: "function name ... is not unique"). The old
-- signatures must be dropped explicitly first.
-- ---------------------------------------------------------------------

drop function if exists public.clock_in_user(double precision, double precision, text);
drop function if exists public.clock_out_user(double precision, double precision, text);
drop function if exists public.start_cb();
drop function if exists public.end_cb();
drop function if exists public.start_lb();
drop function if exists public.end_lb();

create or replace function public.clock_in_user(
  p_lat double precision,
  p_lng double precision,
  p_geo_status text,
  p_attempted_timestamp timestamptz default null,
  p_offline_duration_seconds integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
    perform private.log_audit_event(v_org_id, v_user_id, v_user_id, 'RATE_LIMIT_TRIGGERED', null, null);
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
$$;

create or replace function public.clock_out_user(
  p_lat double precision,
  p_lng double precision,
  p_geo_status text,
  p_attempted_timestamp timestamptz default null,
  p_offline_duration_seconds integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
    perform private.log_audit_event(v_org_id, v_user_id, v_user_id, 'RATE_LIMIT_TRIGGERED', null, null);
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
$$;

revoke execute on function public.clock_in_user from public, anon;
revoke execute on function public.clock_out_user from public, anon;
grant execute on function public.clock_in_user to authenticated;
grant execute on function public.clock_out_user to authenticated;

-- ---------------------------------------------------------------------
-- start_cb / end_cb / start_lb / end_lb: same two offline-only params +
-- drift check, bodies otherwise unchanged from M3.
-- ---------------------------------------------------------------------

create or replace function public.start_cb(
  p_attempted_timestamp timestamptz default null,
  p_offline_duration_seconds integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
    perform private.log_audit_event(v_org_id, v_user_id, v_user_id, 'RATE_LIMIT_TRIGGERED', null, null);
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
$$;

create or replace function public.end_cb(
  p_attempted_timestamp timestamptz default null,
  p_offline_duration_seconds integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
    perform private.log_audit_event(v_org_id, v_user_id, v_user_id, 'RATE_LIMIT_TRIGGERED', null, null);
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
$$;

create or replace function public.start_lb(
  p_attempted_timestamp timestamptz default null,
  p_offline_duration_seconds integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
    perform private.log_audit_event(v_org_id, v_user_id, v_user_id, 'RATE_LIMIT_TRIGGERED', null, null);
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
$$;

create or replace function public.end_lb(
  p_attempted_timestamp timestamptz default null,
  p_offline_duration_seconds integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
    perform private.log_audit_event(v_org_id, v_user_id, v_user_id, 'RATE_LIMIT_TRIGGERED', null, null);
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
$$;

revoke execute on function public.start_cb from public, anon;
revoke execute on function public.end_cb from public, anon;
revoke execute on function public.start_lb from public, anon;
revoke execute on function public.end_lb from public, anon;
grant execute on function public.start_cb to authenticated;
grant execute on function public.end_cb to authenticated;
grant execute on function public.start_lb to authenticated;
grant execute on function public.end_lb to authenticated;
