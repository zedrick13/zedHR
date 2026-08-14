-- SPEC.md M3: core timekeeping loop.
--
-- M3 deviation from the abbreviated §4 signature `clock_in_user(lat,lng)`:
-- a third parameter p_geo_status is required. "denied" (user rejected the
-- browser permission prompt) and "unavailable" (permission granted but no
-- fix obtained) are both client-side facts that can't be distinguished from
-- null coordinates alone — the RPC can't infer which one happened, so the
-- client must say so explicitly. Documented in SPEC.md alongside this
-- migration.
--
-- Also: geofence-breach notifications (Template C) are explicitly M5's
-- deliverable ("NTF_Notification insert helpers with dedupe-window logic")
-- — M3 computes and stores clock_in_outside_boundary/clock_out_outside_boundary
-- (its own explicit checklist item) but does not insert notifications yet.

-- ---------------------------------------------------------------------
-- Work-arrangement cascade (day → user → department → org). SECURITY
-- DEFINER so it can be called mid-RPC regardless of RLS.
-- ---------------------------------------------------------------------

create or replace function private.resolve_work_arrangement(
  p_user_id uuid,
  p_department_id uuid,
  p_organization_id uuid,
  p_date date
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_arrangement text;
begin
  select arrangement into v_arrangement
    from public."TIM_WorkArrangement"
    where target_level = 'day' and target_id = p_user_id and effective_date = p_date
    limit 1;
  if v_arrangement is not null then
    return v_arrangement;
  end if;

  select arrangement into v_arrangement
    from public."TIM_WorkArrangement"
    where target_level = 'user' and target_id = p_user_id
      and effective_date <= p_date and (expires_date is null or expires_date >= p_date)
    order by effective_date desc
    limit 1;
  if v_arrangement is not null then
    return v_arrangement;
  end if;

  if p_department_id is not null then
    select arrangement into v_arrangement
      from public."TIM_WorkArrangement"
      where target_level = 'department' and target_id = p_department_id
        and effective_date <= p_date and (expires_date is null or expires_date >= p_date)
      order by effective_date desc
      limit 1;
    if v_arrangement is not null then
      return v_arrangement;
    end if;
  end if;

  select arrangement into v_arrangement
    from public."TIM_WorkArrangement"
    where target_level = 'organization' and target_id = p_organization_id
      and effective_date <= p_date and (expires_date is null or expires_date >= p_date)
    order by effective_date desc
    limit 1;
  if v_arrangement is not null then
    return v_arrangement;
  end if;

  -- Nothing configured at any level anywhere (flagged assumption, SPEC.md
  -- §11): default to the conservative choice — office, so geofencing applies.
  return 'office';
end;
$$;

create or replace function private.haversine_distance_m(
  p_lat1 double precision, p_lng1 double precision,
  p_lat2 double precision, p_lng2 double precision
)
returns double precision
language sql
immutable
as $$
  select 6371000 * 2 * asin(least(1, sqrt(
    sin(radians(p_lat2 - p_lat1) / 2) ^ 2 +
    cos(radians(p_lat1)) * cos(radians(p_lat2)) * sin(radians(p_lng2 - p_lng1) / 2) ^ 2
  )));
$$;

revoke execute on function private.resolve_work_arrangement from authenticated, anon, public;
revoke execute on function private.haversine_distance_m from authenticated, anon, public;

-- ---------------------------------------------------------------------
-- clock_in_user / clock_out_user
-- ---------------------------------------------------------------------

create or replace function public.clock_in_user(
  p_lat double precision,
  p_lng double precision,
  p_geo_status text
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

  select organization_id, department_id into v_org_id, v_dept_id
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

  return v_session_id;
end;
$$;

create or replace function public.clock_out_user(
  p_lat double precision,
  p_lng double precision,
  p_geo_status text
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

  select organization_id, department_id into v_org_id, v_dept_id
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

  return v_session.id;
end;
$$;

revoke execute on function public.clock_in_user from public, anon;
revoke execute on function public.clock_out_user from public, anon;
grant execute on function public.clock_in_user to authenticated;
grant execute on function public.clock_out_user to authenticated;
