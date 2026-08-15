-- SPEC.md M5: dashboard headcount + Direct Reports grid.
--
-- The grid needs, per visible employee: today's status (clocked
-- in/on break/clocked out), today's worked seconds, and a geofence state
-- (Ok / Out of Bounds / N/A (WFH) / N/A (No GPS)). None of that is a plain
-- column select — it's derived from today's TIM_WorkSession row(s) plus the
-- same work-arrangement cascade clock_in_user/clock_out_user already use —
-- so it's computed server-side in one RPC rather than N client-side calls
-- (mirrors get_active_session_state's precedent from M3, just for many
-- users instead of the caller alone). SECURITY DEFINER so it can read
-- across the caller's managed department(s) regardless of RLS; the role/org
-- scoping it applies internally is the same shape RLS already enforces on
-- MST_User/TIM_WorkSession, so no new access is actually granted.
--
-- No rate limit / audit log: this is a read of data the caller could already
-- reach one row at a time under RLS, same precedent as get_active_session_state.

create or replace function public.get_direct_reports_status()
returns table (
  user_id uuid,
  first_name text,
  last_name text,
  department_id uuid,
  department_name text,
  status text,
  today_seconds integer,
  geofence_state text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_role text := private.app_user_role();
  v_org_id uuid := private.app_user_org_id();
  v_tz text;
  v_local_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
begin
  if v_actor_id is null then
    raise exception 'UNAUTHORIZED';
  end if;
  if v_role not in ('manager', 'admin') then
    raise exception 'UNAUTHORIZED';
  end if;

  select timezone into v_tz from public."MST_Organization" where id = v_org_id;
  v_local_date := (now() at time zone v_tz)::date;
  v_day_start := v_local_date::timestamp at time zone v_tz;
  v_day_end := v_day_start + interval '1 day';

  return query
  select
    u.id,
    u.first_name,
    u.last_name,
    u.department_id,
    d.name,
    case
      when latest.session_id is null then 'clocked_out'
      when latest.clock_out_time is not null then 'clocked_out'
      when exists (
        select 1 from public."TIM_CompensableBreak" cb
        where cb.work_session_id = latest.session_id and cb.end_time is null
      ) then 'on_cb'
      when exists (
        select 1 from public."TIM_NonCompensableBreak" lb
        where lb.work_session_id = latest.session_id and lb.end_time is null
      ) then 'on_lb'
      else 'clocked_in'
    end as status,
    coalesce(totals.total_seconds, 0)::integer as today_seconds,
    case
      when latest.session_id is null then null
      when arr.effective_arrangement = 'wfh' then 'wfh'
      when latest.clock_in_geo_status is distinct from 'checked' then 'no_gps'
      when latest.clock_in_outside_boundary then 'out_of_bounds'
      else 'ok'
    end as geofence_state
  from public."MST_User" u
  left join public."MST_Department" d on d.id = u.department_id
  left join lateral (
    select
      case
        when private.resolve_work_arrangement(u.id, u.department_id, v_org_id, v_local_date) = 'wfh' then 'wfh'
        else 'office'
      end as effective_arrangement
  ) arr on true
  left join lateral (
    select ws.id as session_id, ws.clock_out_time, ws.clock_in_geo_status, ws.clock_in_outside_boundary
    from public."TIM_WorkSession" ws
    where ws.user_id = u.id
      and ws.clock_in_time >= v_day_start and ws.clock_in_time < v_day_end
    order by ws.clock_in_time desc
    limit 1
  ) latest on true
  left join lateral (
    select sum(extract(epoch from (coalesce(ws.clock_out_time, now()) - ws.clock_in_time)))::integer as total_seconds
    from public."TIM_WorkSession" ws
    where ws.user_id = u.id
      and ws.clock_in_time >= v_day_start and ws.clock_in_time < v_day_end
  ) totals on true
  where u.organization_id = v_org_id
    and u.is_active = true
    and u.id <> v_actor_id
    and (
      v_role = 'admin'
      or (
        v_role = 'manager'
        and u.department_id in (select id from public."MST_Department" where manager_id = v_actor_id)
      )
    )
  order by u.first_name, u.last_name;
end;
$$;

revoke execute on function public.get_direct_reports_status from public, anon;
grant execute on function public.get_direct_reports_status to authenticated;
