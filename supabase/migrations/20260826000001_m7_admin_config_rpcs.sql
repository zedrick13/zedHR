-- SPEC.md M7: admin config screens (departments, work arrangements,
-- holidays, org settings) — SPEC §3.2's RLS matrix already says these four
-- tables are "R all roles; W (aal2)" but no write RPCs existed anywhere
-- before this migration (unlike MST_User, which got change_user_role/
-- terminate_user in M2). Added here, following the same
-- require_admin_write()-first, validate, write, log_audit_event shape
-- every other admin RPC in this app uses.
--
-- Six new action_type values extend the closed AUD_SystemLog registry
-- (CLAUDE.md invariant #9's sibling rule, same as M6/M7's earlier
-- additions): DEPARTMENT_CREATED, DEPARTMENT_UPDATED, WORK_ARRANGEMENT_SET,
-- HOLIDAY_CREATED, HOLIDAY_DELETED, ORG_SETTINGS_UPDATED.

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
      'SUSPICIOUS_DRIFT_DETECTED',
      'DEPARTMENT_CREATED',
      'DEPARTMENT_UPDATED',
      'WORK_ARRANGEMENT_SET',
      'HOLIDAY_CREATED',
      'HOLIDAY_DELETED',
      'ORG_SETTINGS_UPDATED'
    )
  );

-- ---------------------------------------------------------------------
-- Departments
-- ---------------------------------------------------------------------

create or replace function public.create_department(p_name text, p_manager_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid;
  v_dept_id uuid;
begin
  perform private.require_admin_write();
  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  if p_name is null or char_length(trim(p_name)) = 0 or char_length(p_name) > 200 then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_manager_id is not null and not exists (
    select 1 from public."MST_User"
    where id = p_manager_id and organization_id = v_org_id and role in ('manager', 'admin')
  ) then
    raise exception 'ERR_VALIDATION';
  end if;

  insert into public."MST_Department" (organization_id, name, manager_id)
  values (v_org_id, p_name, p_manager_id)
  returning id into v_dept_id;

  perform private.log_audit_event(v_org_id, v_actor_id, v_dept_id, 'DEPARTMENT_CREATED', null,
    jsonb_build_object('name', p_name, 'manager_id', p_manager_id));

  return v_dept_id;
end;
$$;

create or replace function public.update_department(p_department_id uuid, p_name text, p_manager_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid;
  v_previous record;
begin
  perform private.require_admin_write();
  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  if p_name is null or char_length(trim(p_name)) = 0 or char_length(p_name) > 200 then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_manager_id is not null and not exists (
    select 1 from public."MST_User"
    where id = p_manager_id and organization_id = v_org_id and role in ('manager', 'admin')
  ) then
    raise exception 'ERR_VALIDATION';
  end if;

  select * into v_previous from public."MST_Department"
    where id = p_department_id and organization_id = v_org_id;
  if v_previous.id is null then
    raise exception 'DEPARTMENT_NOT_FOUND';
  end if;

  update public."MST_Department" set name = p_name, manager_id = p_manager_id where id = p_department_id;

  perform private.log_audit_event(v_org_id, v_actor_id, p_department_id, 'DEPARTMENT_UPDATED',
    jsonb_build_object('name', v_previous.name, 'manager_id', v_previous.manager_id),
    jsonb_build_object('name', p_name, 'manager_id', p_manager_id));
end;
$$;

-- ---------------------------------------------------------------------
-- Work arrangements. set_work_arrangement upserts the single standing row
-- for a given (target_level, target_id, effective_date) rather than
-- letting duplicates accumulate — day-level overrides are naturally
-- one-per-day, and org/department/user-level "standing" arrangements are
-- kept to one active row per target by expiring any prior open-ended row
-- for that exact target before inserting the new one.
-- ---------------------------------------------------------------------

create or replace function public.preview_work_arrangement(
  p_user_id uuid,
  p_department_id uuid,
  p_date date
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  perform private.require_admin_write();
  select organization_id into v_org_id from public."MST_User" where id = auth.uid();
  return private.resolve_work_arrangement(p_user_id, p_department_id, v_org_id, p_date);
end;
$$;

create or replace function public.set_work_arrangement(
  p_target_level text,
  p_target_id uuid,
  p_arrangement text,
  p_effective_date date,
  p_expires_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid;
  v_arrangement_id uuid;
begin
  perform private.require_admin_write();
  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  if p_target_level not in ('organization', 'department', 'user', 'day') then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_arrangement not in ('office', 'wfh', 'hybrid') then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_expires_date is not null and p_expires_date < p_effective_date then
    raise exception 'INVALID_TIME_RANGE';
  end if;

  -- Expire any prior open-ended row for this exact target rather than
  -- accumulating overlapping standing arrangements (day-level rows are
  -- naturally distinct per effective_date, so this is a no-op for those).
  if p_target_level <> 'day' then
    update public."TIM_WorkArrangement"
      set expires_date = p_effective_date - 1
      where organization_id = v_org_id
        and target_level = p_target_level
        and target_id = p_target_id
        and (expires_date is null or expires_date >= p_effective_date)
        and effective_date < p_effective_date;
  end if;

  insert into public."TIM_WorkArrangement" (
    organization_id, target_level, target_id, arrangement, effective_date, expires_date
  ) values (
    v_org_id, p_target_level, p_target_id, p_arrangement, p_effective_date, p_expires_date
  )
  returning id into v_arrangement_id;

  perform private.log_audit_event(v_org_id, v_actor_id, v_arrangement_id, 'WORK_ARRANGEMENT_SET', null,
    jsonb_build_object(
      'target_level', p_target_level, 'target_id', p_target_id,
      'arrangement', p_arrangement, 'effective_date', p_effective_date
    ));

  return v_arrangement_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Holidays
-- ---------------------------------------------------------------------

create or replace function public.create_holiday(
  p_date date,
  p_name text,
  p_type text,
  p_region_scope text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid;
  v_holiday_id uuid;
begin
  perform private.require_admin_write();
  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  if p_name is null or char_length(trim(p_name)) = 0 or char_length(p_name) > 200 then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_type not in ('regular', 'special_non_working', 'custom') then
    raise exception 'ERR_VALIDATION';
  end if;

  insert into public."MST_Holiday" (organization_id, date, name, type, region_scope)
  values (v_org_id, p_date, p_name, p_type, p_region_scope)
  returning id into v_holiday_id;

  perform private.log_audit_event(v_org_id, v_actor_id, v_holiday_id, 'HOLIDAY_CREATED', null,
    jsonb_build_object('date', p_date, 'name', p_name, 'type', p_type));

  return v_holiday_id;
end;
$$;

create or replace function public.delete_holiday(p_holiday_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid;
  v_holiday record;
begin
  perform private.require_admin_write();
  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  select * into v_holiday from public."MST_Holiday"
    where id = p_holiday_id and organization_id = v_org_id;
  if v_holiday.id is null then
    raise exception 'HOLIDAY_NOT_FOUND';
  end if;

  delete from public."MST_Holiday" where id = p_holiday_id;

  perform private.log_audit_event(v_org_id, v_actor_id, p_holiday_id, 'HOLIDAY_DELETED',
    jsonb_build_object('date', v_holiday.date, 'name', v_holiday.name), null);
end;
$$;

-- ---------------------------------------------------------------------
-- Org settings
-- ---------------------------------------------------------------------

create or replace function public.update_organization_settings(
  p_timezone text,
  p_display_locale text,
  p_pay_cycle_type text,
  p_pay_cycle_start_date date,
  p_geofence_latitude double precision default null,
  p_geofence_longitude double precision default null,
  p_geofence_radius_m integer default null,
  p_max_cb_minutes integer default 20,
  p_min_lb_minutes integer default 30,
  p_data_retention_days integer default 365
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid;
  v_previous record;
begin
  perform private.require_admin_write();
  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  if p_pay_cycle_type not in ('weekly', 'biweekly', 'monthly') then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_timezone is null or char_length(trim(p_timezone)) = 0 then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_max_cb_minutes is null or p_max_cb_minutes <= 0 or p_min_lb_minutes is null or p_min_lb_minutes <= 0 then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_data_retention_days is null or p_data_retention_days <= 0 then
    raise exception 'ERR_VALIDATION';
  end if;
  if (p_geofence_latitude is null) <> (p_geofence_longitude is null) then
    raise exception 'ERR_VALIDATION';
  end if;

  select * into v_previous from public."MST_Organization" where id = v_org_id;

  update public."MST_Organization"
    set timezone = p_timezone,
        display_locale = p_display_locale,
        pay_cycle_type = p_pay_cycle_type,
        pay_cycle_start_date = p_pay_cycle_start_date,
        geofence_latitude = p_geofence_latitude,
        geofence_longitude = p_geofence_longitude,
        geofence_radius_m = p_geofence_radius_m,
        max_cb_minutes = p_max_cb_minutes,
        min_lb_minutes = p_min_lb_minutes,
        data_retention_days = p_data_retention_days
    where id = v_org_id;

  perform private.log_audit_event(v_org_id, v_actor_id, v_org_id, 'ORG_SETTINGS_UPDATED',
    jsonb_build_object(
      'timezone', v_previous.timezone, 'pay_cycle_type', v_previous.pay_cycle_type,
      'max_cb_minutes', v_previous.max_cb_minutes, 'min_lb_minutes', v_previous.min_lb_minutes
    ),
    jsonb_build_object(
      'timezone', p_timezone, 'pay_cycle_type', p_pay_cycle_type,
      'max_cb_minutes', p_max_cb_minutes, 'min_lb_minutes', p_min_lb_minutes
    ));
end;
$$;

revoke execute on function public.create_department from public, anon;
revoke execute on function public.update_department from public, anon;
revoke execute on function public.preview_work_arrangement from public, anon;
revoke execute on function public.set_work_arrangement from public, anon;
revoke execute on function public.create_holiday from public, anon;
revoke execute on function public.delete_holiday from public, anon;
revoke execute on function public.update_organization_settings from public, anon;
grant execute on function public.create_department to authenticated;
grant execute on function public.update_department to authenticated;
grant execute on function public.preview_work_arrangement to authenticated;
grant execute on function public.set_work_arrangement to authenticated;
grant execute on function public.create_holiday to authenticated;
grant execute on function public.delete_holiday to authenticated;
grant execute on function public.update_organization_settings to authenticated;
