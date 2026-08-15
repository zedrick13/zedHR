-- SPEC.md M3: start_cb/end_cb/start_lb/end_lb, get_active_session_state.

create or replace function public.start_cb()
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
  return v_break_id;
end;
$$;

create or replace function public.end_cb()
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

  return v_break.id;
end;
$$;

create or replace function public.start_lb()
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
  return v_break_id;
end;
$$;

create or replace function public.end_lb()
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

  return v_break.id;
end;
$$;

-- Read-only, no rate limit (SPEC §4).
create or replace function public.get_active_session_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session record;
  v_cb record;
  v_lb record;
  v_has_cb boolean;
  v_has_lb boolean;
  v_state text;
begin
  if v_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select * into v_session from public."TIM_WorkSession"
    where user_id = v_user_id and clock_out_time is null
    limit 1;

  if v_session is null then
    return jsonb_build_object('state', 'CLOCKED_OUT', 'session', null, 'active_break', null);
  end if;

  select * into v_cb from public."TIM_CompensableBreak"
    where work_session_id = v_session.id and end_time is null limit 1;
  v_has_cb := not (v_cb is null);
  select * into v_lb from public."TIM_NonCompensableBreak"
    where work_session_id = v_session.id and end_time is null limit 1;
  v_has_lb := not (v_lb is null);

  -- NOTE: `record_var IS NOT NULL` is unreliable in PL/pgSQL for a plain
  -- `record`-typed variable — it evaluates false even when a row was found.
  -- `NOT (... IS NULL)`, captured right after each SELECT, is the reliable
  -- equivalent (see the same note in the M3 clock_in/out migration).
  v_state := case
    when v_has_cb then 'ON_CB'
    when v_has_lb then 'ON_LB'
    else 'CLOCKED_IN_IDLE'
  end;

  return jsonb_build_object(
    'state', v_state,
    'session', jsonb_build_object(
      'id', v_session.id,
      'clock_in_time', v_session.clock_in_time,
      'clock_in_outside_boundary', v_session.clock_in_outside_boundary,
      'clock_in_geo_status', v_session.clock_in_geo_status
    ),
    'active_break', case
      when v_has_cb then jsonb_build_object('type', 'cb', 'id', v_cb.id, 'start_time', v_cb.start_time)
      when v_has_lb then jsonb_build_object('type', 'lb', 'id', v_lb.id, 'start_time', v_lb.start_time)
      else null
    end
  );
end;
$$;

revoke execute on function public.start_cb from public, anon;
revoke execute on function public.end_cb from public, anon;
revoke execute on function public.start_lb from public, anon;
revoke execute on function public.end_lb from public, anon;
revoke execute on function public.get_active_session_state from public, anon;
grant execute on function public.start_cb to authenticated;
grant execute on function public.end_cb to authenticated;
grant execute on function public.start_lb to authenticated;
grant execute on function public.end_lb to authenticated;
grant execute on function public.get_active_session_state to authenticated;
