-- SPEC.md M4: corrections workflow.
--
-- Notification scope note: Templates B (submit -> manager) and D
-- (approve/reject -> employee) need no dedupe window, unlike C/E which are
-- explicitly M5's own deliverable ("dedupe-window logic"). So unlike M3
-- (which deferred Template C entirely to M5), M4 inserts B/D directly via a
-- plain, non-deduped helper.

create or replace function private.create_notification(
  p_organization_id uuid,
  p_recipient_id uuid,
  p_template text,
  p_title text,
  p_body text,
  p_link_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public."NTF_Notification" (organization_id, recipient_id, template, title, body, link_path)
  values (p_organization_id, p_recipient_id, p_template, p_title, p_body, p_link_path)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function private.create_notification from authenticated, anon, public;

-- ---------------------------------------------------------------------
-- submit_correction_request
-- ---------------------------------------------------------------------

create or replace function public.submit_correction_request(
  p_work_session_id uuid,
  p_request_type text,
  p_requested_timestamp timestamptz,
  p_reason text
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
    perform private.log_audit_event(v_org_id, v_user_id, v_user_id, 'RATE_LIMIT_TRIGGERED', null, null);
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
$$;

revoke execute on function public.submit_correction_request from public, anon;
grant execute on function public.submit_correction_request to authenticated;

-- ---------------------------------------------------------------------
-- Applying an approved correction to the underlying record. Not exposed
-- directly — called only from approve_correction_request.
--
-- cb_start/cb_end/lb_start/lb_end target "the most recent break of that
-- type on this session" (not in SPEC's abbreviated schema — TIM_CorrectionRequest
-- has no break_id column, and adding one would be exactly the kind of
-- schema-widening the create_session note explicitly says not to do for
-- missing shifts). *_start corrects the most recent break if one exists,
-- else opens a new one (mirrors create_session's "the record didn't fully
-- exist yet" shape); *_end corrects the most recent open-or-closed break.
-- ---------------------------------------------------------------------

create or replace function private.apply_correction(
  p_correction record
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := p_correction.organization_id;
  v_break_id uuid;
  v_new_session_id uuid;
  v_max_cb integer;
  v_min_lb integer;
  v_duration_minutes numeric;
begin
  if p_correction.request_type = 'clock_in' then
    update public."TIM_WorkSession" set clock_in_time = p_correction.requested_timestamp
      where id = p_correction.work_session_id;

  elsif p_correction.request_type = 'clock_out' then
    update public."TIM_WorkSession" set clock_out_time = p_correction.requested_timestamp
      where id = p_correction.work_session_id;

  elsif p_correction.request_type = 'create_session' then
    insert into public."TIM_WorkSession" (
      user_id, organization_id, clock_in_time, clock_in_geo_status
    ) values (
      p_correction.user_id, v_org_id, p_correction.requested_timestamp, 'unavailable'
    )
    returning id into v_new_session_id;

    -- Link the correction to the session it created (SPEC's "two linked
    -- requests" note: the follow-up clock_out request is submitted by the
    -- employee against this new session id once they see it).
    update public."TIM_CorrectionRequest" set work_session_id = v_new_session_id
      where id = p_correction.id;

  elsif p_correction.request_type = 'cb_start' then
    select id into v_break_id from public."TIM_CompensableBreak"
      where work_session_id = p_correction.work_session_id
      order by start_time desc limit 1;
    if v_break_id is null then
      insert into public."TIM_CompensableBreak" (organization_id, work_session_id, start_time)
      values (v_org_id, p_correction.work_session_id, p_correction.requested_timestamp);
    else
      update public."TIM_CompensableBreak" set start_time = p_correction.requested_timestamp
        where id = v_break_id;
    end if;

  elsif p_correction.request_type = 'cb_end' then
    select id into v_break_id from public."TIM_CompensableBreak"
      where work_session_id = p_correction.work_session_id
      order by start_time desc limit 1;
    if v_break_id is not null then
      select max_cb_minutes into v_max_cb from public."MST_Organization" where id = v_org_id;
      select extract(epoch from (p_correction.requested_timestamp - start_time)) / 60
        into v_duration_minutes
        from public."TIM_CompensableBreak" where id = v_break_id;
      update public."TIM_CompensableBreak"
        set end_time = p_correction.requested_timestamp,
            policy_violation = v_duration_minutes > v_max_cb,
            policy_violation_reason = case when v_duration_minutes > v_max_cb then 'CB_OVERTIME' else null end
        where id = v_break_id;
    end if;

  elsif p_correction.request_type = 'lb_start' then
    select id into v_break_id from public."TIM_NonCompensableBreak"
      where work_session_id = p_correction.work_session_id
      order by start_time desc limit 1;
    if v_break_id is null then
      insert into public."TIM_NonCompensableBreak" (organization_id, work_session_id, start_time)
      values (v_org_id, p_correction.work_session_id, p_correction.requested_timestamp);
    else
      update public."TIM_NonCompensableBreak" set start_time = p_correction.requested_timestamp
        where id = v_break_id;
    end if;

  elsif p_correction.request_type = 'lb_end' then
    select id into v_break_id from public."TIM_NonCompensableBreak"
      where work_session_id = p_correction.work_session_id
      order by start_time desc limit 1;
    if v_break_id is not null then
      select min_lb_minutes into v_min_lb from public."MST_Organization" where id = v_org_id;
      select extract(epoch from (p_correction.requested_timestamp - start_time)) / 60
        into v_duration_minutes
        from public."TIM_NonCompensableBreak" where id = v_break_id;
      update public."TIM_NonCompensableBreak"
        set end_time = p_correction.requested_timestamp,
            policy_violation = v_duration_minutes < v_min_lb,
            policy_violation_reason = case when v_duration_minutes < v_min_lb then 'LB_SHORT' else null end
        where id = v_break_id;
    end if;
  end if;
end;
$$;

revoke execute on function private.apply_correction from authenticated, anon, public;

-- ---------------------------------------------------------------------
-- approve_correction_request / reject_correction_request
-- ---------------------------------------------------------------------

create or replace function public.approve_correction_request(p_correction_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_correction record;
  v_updated_rows integer;
begin
  perform private.require_manager_or_admin_write();
  v_actor_role := private.app_user_role();

  select * into v_correction from public."TIM_CorrectionRequest" where id = p_correction_id;
  if v_correction.id is null then
    raise exception 'CORRECTION_NOT_FOUND';
  end if;

  if v_actor_role = 'manager' and not private.app_is_managing_user(v_correction.user_id) then
    raise exception 'UNAUTHORIZED';
  end if;

  update public."TIM_CorrectionRequest"
    set status = 'approved', reviewed_by = v_actor_id, reviewed_at = now()
    where id = p_correction_id and status = 'pending';
  get diagnostics v_updated_rows = row_count;

  if v_updated_rows = 0 then
    raise exception 'CORRECTION_ALREADY_RESOLVED';
  end if;

  perform private.apply_correction(v_correction);

  perform private.log_audit_event(v_correction.organization_id, v_actor_id, p_correction_id,
    'CORRECTION_APPROVED', jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'approved'));

  perform private.create_notification(v_correction.organization_id, v_correction.user_id, 'D',
    'Correction request approved',
    'Your timesheet correction request was approved.',
    '/requests');
end;
$$;

create or replace function public.reject_correction_request(p_correction_id uuid, p_rejection_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_correction record;
  v_updated_rows integer;
begin
  perform private.require_manager_or_admin_write();
  v_actor_role := private.app_user_role();

  if p_rejection_note is not null and char_length(p_rejection_note) > 500 then
    raise exception 'ERR_VALIDATION';
  end if;

  select * into v_correction from public."TIM_CorrectionRequest" where id = p_correction_id;
  if v_correction.id is null then
    raise exception 'CORRECTION_NOT_FOUND';
  end if;

  if v_actor_role = 'manager' and not private.app_is_managing_user(v_correction.user_id) then
    raise exception 'UNAUTHORIZED';
  end if;

  update public."TIM_CorrectionRequest"
    set status = 'rejected', reviewed_by = v_actor_id, reviewed_at = now(), rejection_note = p_rejection_note
    where id = p_correction_id and status = 'pending';
  get diagnostics v_updated_rows = row_count;

  if v_updated_rows = 0 then
    raise exception 'CORRECTION_ALREADY_RESOLVED';
  end if;

  -- Original TIM_WorkSession/breaks are never touched on rejection.
  perform private.log_audit_event(v_correction.organization_id, v_actor_id, p_correction_id,
    'CORRECTION_REJECTED', jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'rejected'));

  perform private.create_notification(v_correction.organization_id, v_correction.user_id, 'D',
    'Correction request rejected',
    coalesce('Your timesheet correction request was rejected: ' || p_rejection_note,
             'Your timesheet correction request was rejected.'),
    '/requests');
end;
$$;

revoke execute on function public.approve_correction_request from public, anon;
revoke execute on function public.reject_correction_request from public, anon;
grant execute on function public.approve_correction_request to authenticated;
grant execute on function public.reject_correction_request to authenticated;

-- ---------------------------------------------------------------------
-- admin_edit_locked_timecard
-- ---------------------------------------------------------------------

create or replace function public.admin_edit_locked_timecard(
  p_session_id uuid,
  p_clock_in timestamptz,
  p_clock_out timestamptz,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid;
  v_session record;
begin
  perform private.require_admin_write();

  if p_reason is null or char_length(trim(p_reason)) = 0 then
    raise exception 'EDIT_REASON_REQUIRED';
  end if;

  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  select * into v_session from public."TIM_WorkSession"
    where id = p_session_id and organization_id = v_org_id;
  if v_session.id is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  if p_clock_out is not null and p_clock_out <= p_clock_in then
    raise exception 'INVALID_TIME_RANGE';
  end if;

  update public."TIM_WorkSession"
    set clock_in_time = p_clock_in, clock_out_time = p_clock_out
    where id = p_session_id;

  perform private.log_audit_event(v_org_id, v_actor_id, p_session_id, 'TIMECARD_ADMIN_EDITED',
    jsonb_build_object('clock_in_time', v_session.clock_in_time, 'clock_out_time', v_session.clock_out_time),
    jsonb_build_object('clock_in_time', p_clock_in, 'clock_out_time', p_clock_out, 'reason', p_reason));
end;
$$;

revoke execute on function public.admin_edit_locked_timecard from public, anon;
grant execute on function public.admin_edit_locked_timecard to authenticated;
