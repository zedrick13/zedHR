-- SPEC.md M5: notification dedupe-window helper + Template C wiring.
--
-- Template C (geofence breach) and Template E (long-running session) both
-- need "at most one notification per key per window" — unlike Templates B/D
-- (M4, plain insert every time). This migration adds the shared dedupe
-- helper and wires Template C into clock_in_user/clock_out_user (M3 already
-- computes and stores clock_in_outside_boundary/clock_out_outside_boundary;
-- it just didn't insert the notification yet). Template E's actual trigger
-- site is the M7 auto-close cron job — that job will call this same helper
-- with dedupe_key 'longrun:{session_id}' and a 24h window once it exists.

create or replace function private.create_deduped_notification(
  p_organization_id uuid,
  p_recipient_id uuid,
  p_template text,
  p_title text,
  p_body text,
  p_link_path text,
  p_dedupe_key text,
  p_dedupe_window interval
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if exists (
    select 1 from public."NTF_Notification"
    where dedupe_key = p_dedupe_key
      and created_at > now() - p_dedupe_window
  ) then
    return null;
  end if;

  insert into public."NTF_Notification" (
    organization_id, recipient_id, template, title, body, link_path, dedupe_key
  ) values (
    p_organization_id, p_recipient_id, p_template, p_title, p_body, p_link_path, p_dedupe_key
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function private.create_deduped_notification from authenticated, anon, public;

-- ---------------------------------------------------------------------
-- Template C: geofence breach -> department manager (or every admin if the
-- employee's department is unmanaged, same fallback submit_correction_request
-- uses for Template B). Dedupe key is per manager/employee pair (SPEC §4:
-- "geofence:{manager_id}:{employee_id}", 12h) so repeated punches by the same
-- employee outside the fence don't spam the same manager.
-- ---------------------------------------------------------------------

create or replace function private.notify_geofence_breach(
  p_organization_id uuid,
  p_department_id uuid,
  p_employee_id uuid,
  p_employee_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_manager_id uuid;
  v_admin_id uuid;
begin
  select manager_id into v_manager_id from public."MST_Department" where id = p_department_id;

  if v_manager_id is not null then
    perform private.create_deduped_notification(
      p_organization_id, v_manager_id, 'C',
      'Geofence breach',
      p_employee_name || ' punched outside the office geofence.',
      '/dashboard',
      'geofence:' || v_manager_id || ':' || p_employee_id,
      interval '12 hours'
    );
  else
    for v_admin_id in
      select id from public."MST_User" where organization_id = p_organization_id and role = 'admin'
    loop
      perform private.create_deduped_notification(
        p_organization_id, v_admin_id, 'C',
        'Geofence breach',
        p_employee_name || ' punched outside the office geofence.',
        '/dashboard',
        'geofence:' || v_admin_id || ':' || p_employee_id,
        interval '12 hours'
      );
    end loop;
  end if;
end;
$$;

revoke execute on function private.notify_geofence_breach from authenticated, anon, public;

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

  return v_session.id;
end;
$$;

revoke execute on function public.clock_in_user from public, anon;
revoke execute on function public.clock_out_user from public, anon;
grant execute on function public.clock_in_user to authenticated;
grant execute on function public.clock_out_user to authenticated;
