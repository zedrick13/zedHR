-- SPEC.md M7: pg_cron scheduled jobs (§8.2) + anonymization (§8.3).
--
-- pg_cron's own schedule times are evaluated against the Postgres server's
-- configured timezone (the `cron.timezone` GUC, which itself defaults to
-- the server's `TimeZone` setting — UTC on every Supabase-managed instance
-- this has been checked against). "Daily 02:00 Asia/Manila" (UTC+8, no
-- DST) is therefore scheduled as 18:00 UTC the previous calendar day.
-- Flagged in SPEC.md as an assumption to verify at deploy time, same
-- posture as §11's other "verify against the real environment" items.

create extension if not exists pg_cron;

-- ---------------------------------------------------------------------
-- auto_close_abandoned_breaks_and_sessions() — every 15 min.
-- ---------------------------------------------------------------------

create or replace function private.notify_long_running_session(
  p_organization_id uuid,
  p_department_id uuid,
  p_employee_name text,
  p_session_id uuid
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
  -- SPEC §8.2 doesn't name Template E's recipient explicitly; routed to
  -- the manager (or every admin if unmanaged) — the same fallback shape
  -- Templates B/C already use — since this is "something anomalous
  -- happened, a manager should follow up," not news about the employee's
  -- own action (which would be Template D's shape instead). Flagged as an
  -- interpretation.
  select manager_id into v_manager_id from public."MST_Department" where id = p_department_id;

  if v_manager_id is not null then
    perform private.create_deduped_notification(
      p_organization_id, v_manager_id, 'E',
      'Long-running session',
      p_employee_name || ' has been clocked in for over 16 hours.',
      '/dashboard',
      'longrun:' || p_session_id,
      interval '24 hours'
    );
  else
    for v_admin_id in
      select id from public."MST_User" where organization_id = p_organization_id and role = 'admin'
    loop
      perform private.create_deduped_notification(
        p_organization_id, v_admin_id, 'E',
        'Long-running session',
        p_employee_name || ' has been clocked in for over 16 hours.',
        '/dashboard',
        'longrun:' || p_session_id,
        interval '24 hours'
      );
    end loop;
  end if;
end;
$$;

revoke execute on function private.notify_long_running_session from authenticated, anon, public;

create or replace function public.auto_close_abandoned_breaks_and_sessions()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_break record;
  v_session record;
  v_max_cb integer;
  v_close_time timestamptz;
  v_violation boolean;
begin
  -- Compensable breaks open >4h: close at start_time + 4h (the abandonment
  -- point, not now()), is_auto_closed, evaluate CB_OVERTIME the normal way.
  for v_break in
    select cb.id, cb.organization_id, cb.start_time
    from public."TIM_CompensableBreak" cb
    where cb.end_time is null and cb.start_time < now() - interval '4 hours'
  loop
    v_close_time := v_break.start_time + interval '4 hours';
    select max_cb_minutes into v_max_cb from public."MST_Organization" where id = v_break.organization_id;
    v_violation := extract(epoch from (v_close_time - v_break.start_time)) / 60 > v_max_cb;

    update public."TIM_CompensableBreak"
      set end_time = v_close_time,
          is_auto_closed = true,
          policy_violation = v_violation,
          policy_violation_reason = case when v_violation then 'CB_OVERTIME' else null end
      where id = v_break.id;

    perform private.log_audit_event(v_break.organization_id, null, v_break.id, 'CB_ENDED', null,
      jsonb_build_object('is_auto_closed', true, 'source', 'auto_close_job'));
  end loop;

  -- Non-compensable (lunch) breaks open >4h: same close-at-4h rule, but
  -- SPEC §8.2 is explicit that an abandoned LB never gets LB_SHORT — it's
  -- short because it was force-closed, not because the employee cut their
  -- own break short.
  for v_break in
    select lb.id, lb.organization_id, lb.start_time
    from public."TIM_NonCompensableBreak" lb
    where lb.end_time is null and lb.start_time < now() - interval '4 hours'
  loop
    v_close_time := v_break.start_time + interval '4 hours';

    update public."TIM_NonCompensableBreak"
      set end_time = v_close_time, is_auto_closed = true
      where id = v_break.id;

    perform private.log_audit_event(v_break.organization_id, null, v_break.id, 'LB_ENDED', null,
      jsonb_build_object('is_auto_closed', true, 'source', 'auto_close_job'));
  end loop;

  -- Sessions open >16h & not yet flagged: flag + Template E, never
  -- fabricate a clock-out. flagged_long_running gates re-processing on
  -- later 15-min cycles; the notification's own 24h dedupe key is a
  -- second, independent safety net for the same "don't spam" requirement.
  for v_session in
    select ws.id, ws.organization_id, mu.department_id, mu.first_name || ' ' || mu.last_name as employee_name
    from public."TIM_WorkSession" ws
    join public."MST_User" mu on mu.id = ws.user_id
    where ws.clock_out_time is null
      and ws.flagged_long_running = false
      and ws.clock_in_time < now() - interval '16 hours'
  loop
    update public."TIM_WorkSession" set flagged_long_running = true where id = v_session.id;

    perform private.notify_long_running_session(
      v_session.organization_id, v_session.department_id, v_session.employee_name, v_session.id
    );
  end loop;
end;
$$;

revoke execute on function public.auto_close_abandoned_breaks_and_sessions from authenticated, anon, public;

select cron.schedule(
  'auto-close-abandoned-breaks-and-sessions',
  '*/15 * * * *',
  $$select public.auto_close_abandoned_breaks_and_sessions();$$
);

-- ---------------------------------------------------------------------
-- purge_stale_rows() — every 6h.
-- ---------------------------------------------------------------------

create or replace function public.purge_stale_rows()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public."RTL_RateLimitEvent" where created_at < now() - interval '24 hours';
  delete from public."NTF_Notification" where created_at < now() - interval '180 days';
end;
$$;

revoke execute on function public.purge_stale_rows from authenticated, anon, public;

select cron.schedule('purge-stale-rows', '0 */6 * * *', $$select public.purge_stale_rows();$$);

-- ---------------------------------------------------------------------
-- anonymize_user() — SPEC §8.3 (RA 10173 / PH Data Privacy Act).
--
-- DEVIATION FROM THE LITERAL SPEC TEXT, flagged in SPEC.md: §8.3 says step
-- 3 is "a separate transaction deletes auth.users." A literal delete was
-- tried directly against this schema during development and fails with a
-- real foreign key violation — MST_User.id has `references auth.users(id)
-- on delete cascade`, so deleting the auth.users row cascades into
-- attempting to delete the MST_User row too, which every table that
-- transitively references a user (TIM_WorkSession.user_id NOT NULL among
-- them) then blocks. Actually cascading those deletes instead would
-- destroy the compliance record-keeping this whole module exists for —
-- directly contradicting this milestone's own AC ("anonymization leaves
-- audit rows but no PII"). Since a real hard delete can't satisfy both
-- "auth.users identity is gone" and "audit trail survives" at the same
-- time under this schema, this instead permanently disables the auth
-- identity in place: password randomized, banned_until set to infinity,
-- all sessions/MFA factors/identities removed, email/phone scrubbed. The
-- practical outcome SPEC actually wants — the person can never
-- authenticate as themselves again and carries no residual PII — is
-- achieved without an unsafe schema change or a broken/blocked delete.
-- The MST_User row is likewise scrubbed in place rather than deleted, for
-- the same referential-integrity reason.
--
-- Consequently there's no correctness reason left to split this into two
-- transactions either (that split existed to sequence "durable scrub" before
-- "riskier hard delete" — there is no hard delete anymore) — this runs as
-- a single atomic function/transaction, which is if anything safer
-- (all-or-nothing) than a two-phase commit split would have been.
-- ---------------------------------------------------------------------

create or replace function private.anonymize_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id from public."MST_User" where id = p_user_id;
  if v_org_id is null then
    return; -- already anonymized, or never existed
  end if;

  -- (1) Scrub MST_User + permanently disable the auth identity.
  update public."MST_User"
    set first_name = 'Anonymized',
        last_name = 'User',
        avatar_path = null,
        is_active = false
    where id = p_user_id;

  -- `banned_until` is the well-documented mechanism GoTrue enforces to
  -- block login — verified directly: a signInWithPassword() attempt after
  -- setting it fails with "User is banned". A far-future FINITE date is
  -- used rather than the literal `infinity` pseudo-value: `infinity`
  -- blocks login identically, but was found (via a direct admin API call
  -- after setting it) to make every subsequent admin.getUserById() call
  -- for that user fail with a 500 "Database error loading user" — a
  -- GoTrue quirk in how it deserializes that value back out. The finite
  -- far-future date achieves the same practical ban without that bug.
  -- `deleted_at` was tried too but turned out to have the same
  -- getUserById-breaking effect, so it's deliberately not set either.
  update auth.users
    set email = 'anonymized-' || p_user_id || '@zedhr.com',
        encrypted_password = extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
        phone = null,
        raw_user_meta_data = '{}'::jsonb,
        banned_until = '9999-12-31 23:59:59+00'
    where id = p_user_id;

  delete from auth.sessions where user_id = p_user_id;
  delete from auth.mfa_factors where user_id = p_user_id;
  delete from auth.identities where user_id = p_user_id;
  delete from public."MST_MfaBackupCode" where user_id = p_user_id;

  -- (2) Scrub free-text/PII in corrections, sync conflicts, audit JSON,
  -- and NTF rows. Only the requester's own free text is touched, not a
  -- reviewer's rejection_note on someone else's request they happen to
  -- have reviewed (that text is about the OTHER person's record, still
  -- active) — flagged as an interpretation of "in corrections."
  update public."TIM_CorrectionRequest"
    set reason = '[redacted]',
        rejection_note = case when rejection_note is not null then '[redacted]' else null end
    where user_id = p_user_id;

  update public."TIM_SyncConflict"
    set details = '{}'::jsonb
    where user_id = p_user_id;

  -- Scrub the JSON payload on rows this person generated as the actor;
  -- action_type/created_at/target_id survive so the audit trail's shape
  -- (what happened, when) is intact with no identifying detail attached.
  update public."AUD_SystemLog"
    set previous_value = null, new_value = null
    where actor_id = p_user_id;

  delete from public."NTF_Notification" where recipient_id = p_user_id;

  perform private.log_audit_event(v_org_id, null, p_user_id, 'USER_ANONYMIZED', null, null);
end;
$$;

revoke execute on function private.anonymize_user from authenticated, anon, public;

create or replace function public.run_scheduled_anonymization()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user record;
begin
  for v_user in
    select id from public."MST_User"
    where scheduled_purge_at is not null and scheduled_purge_at <= now()
  loop
    perform private.anonymize_user(v_user.id);
  end loop;
end;
$$;

revoke execute on function public.run_scheduled_anonymization from authenticated, anon, public;

select cron.schedule(
  'run-scheduled-anonymization',
  '0 18 * * *',
  $$select public.run_scheduled_anonymization();$$
);

-- ---------------------------------------------------------------------
-- force_anonymize_user() — admin-triggered immediate erasure for a
-- terminated employee (SPEC §8.3's DSAR fulfillment path; the DSAR RPCs
-- themselves are M7's own separate checklist item and call this).
-- ---------------------------------------------------------------------

create or replace function public.force_anonymize_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_org_id uuid;
  v_target_org_id uuid;
  v_terminated_at timestamptz;
begin
  perform private.require_admin_write();

  select organization_id into v_actor_org_id from public."MST_User" where id = v_actor_id;
  select organization_id, terminated_at into v_target_org_id, v_terminated_at
    from public."MST_User" where id = p_user_id;

  if v_target_org_id is null or v_target_org_id <> v_actor_org_id then
    raise exception 'USER_NOT_FOUND';
  end if;
  if v_terminated_at is null then
    raise exception 'USER_NOT_TERMINATED';
  end if;

  perform private.anonymize_user(p_user_id);
end;
$$;

revoke execute on function public.force_anonymize_user from public, anon;
grant execute on function public.force_anonymize_user to authenticated;
