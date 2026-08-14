-- SPEC.md M5: Reports pane CSV export.
--
-- Returns rows (not raw CSV text) so PL/pgSQL never has to do CSV
-- quoting/escaping — the client builds the actual CSV string, same
-- division of labor as every other list-shaped RPC in this app.
-- SECURITY DEFINER so it can read across the caller's managed
-- department(s)/employees regardless of RLS, but every filter argument is
-- validated against the caller's own scope first (a manager can't pass an
-- employee/department id outside what they manage) — no new access is
-- actually granted beyond what get_direct_reports_status already exposes.
--
-- Rate-limited via the 'report_export' bucket per CLAUDE.md invariant #8.
-- SPEC.md doesn't give a specific threshold for this bucket; 20/hour is a
-- deliberate placeholder (flagged in SPEC.md §11, not silently assumed) —
-- generous enough for normal manager/admin use, low enough to bound a
-- runaway export loop.
--
-- Deliberately NOT `stable`: PostgREST/PostgreSQL route a function's call
-- through a read-only transaction when it's tagged stable/immutable, and
-- check_rate_limit()/log_audit_event() both INSERT — the same class of bug
-- already hit (and documented) for custom_access_token_hook in M2.

create or replace function public.export_timesheet_report(
  p_department_id uuid default null,
  p_employee_id uuid default null,
  p_range_start date default null,
  p_range_end date default null
)
returns table (
  employee_name text,
  department_name text,
  session_date text,
  clock_in text,
  clock_out text,
  duration_hours numeric,
  cb_minutes numeric,
  lb_minutes numeric,
  violations text,
  geofence text
)
language plpgsql
security definer
set search_path = public
as $$
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
    perform private.log_audit_event(v_org_id, v_actor_id, v_actor_id, 'RATE_LIMIT_TRIGGERED', null, null);
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
$$;

revoke execute on function public.export_timesheet_report from public, anon;
grant execute on function public.export_timesheet_report to authenticated;
