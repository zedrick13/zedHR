-- SPEC.md §3.2 RLS matrix. CLAUDE.md invariant #2 (all writes go through
-- RPCs, never direct client .insert()/.update()/.delete()) is applied
-- literally: every policy below is SELECT-only, plus the one narrow
-- exception the matrix calls out explicitly (NTF_Notification's
-- is_read/read_at mark-read). Actual writes ("W" in the matrix) happen
-- through SECURITY DEFINER RPCs added in later milestones, which bypass RLS
-- as the table owner — so "R/W own rows" in the matrix is achieved by RLS
-- (R) + RPC (W) together, not by a direct RLS write grant. This resolves an
-- ambiguity in the matrix's shorthand; see the SPEC.md note added alongside
-- this migration.
--
-- CLAUDE.md forward-compat rule #1: organization_id appears in every
-- predicate below, never omitted as "the only org".

-- ---------------------------------------------------------------------
-- Manager-scope helpers (SECURITY DEFINER: bypass RLS internally so they
-- give a clean, non-recursive answer regardless of the caller's own
-- visibility into MST_User/MST_Department/TIM_WorkSession).
-- ---------------------------------------------------------------------

create or replace function private.app_is_managing_user(p_target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public."MST_User" u
    join public."MST_Department" d on d.id = u.department_id
    where u.id = p_target_user_id
      and d.manager_id = auth.uid()
  );
$$;

create or replace function private.app_is_managing_work_session(p_work_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public."TIM_WorkSession" ws
    join public."MST_User" u on u.id = ws.user_id
    join public."MST_Department" d on d.id = u.department_id
    where ws.id = p_work_session_id
      and d.manager_id = auth.uid()
  );
$$;

revoke execute on function private.app_is_managing_user from authenticated, anon, public;
revoke execute on function private.app_is_managing_work_session from authenticated, anon, public;
grant execute on function private.app_is_managing_user to authenticated;
grant execute on function private.app_is_managing_work_session to authenticated;

-- ---------------------------------------------------------------------
-- MST_Organization — R all roles; W deferred to an admin RPC (not yet
-- built; §3.2 "W (aal2)").
-- ---------------------------------------------------------------------

create policy mst_organization_select on public."MST_Organization"
  for select to authenticated
  using (id = private.app_user_org_id());

-- ---------------------------------------------------------------------
-- MST_Department — R all roles; W deferred to an admin RPC.
-- ---------------------------------------------------------------------

create policy mst_department_select on public."MST_Department"
  for select to authenticated
  using (organization_id = private.app_user_org_id());

-- ---------------------------------------------------------------------
-- MST_User — own profile; manager sees managed-dept members (column
-- limiting deferred to the M5 Direct Reports grid — see SPEC.md open
-- items); admin sees all org members. Writes via accept_invitation /
-- terminate_user / change_user_role / admin_reset_mfa RPCs.
-- ---------------------------------------------------------------------

create policy mst_user_select_own on public."MST_User"
  for select to authenticated
  using (id = private.app_current_user_id() and organization_id = private.app_user_org_id());

create policy mst_user_select_managed on public."MST_User"
  for select to authenticated
  using (
    private.app_user_role() = 'manager'
    and organization_id = private.app_user_org_id()
    and private.app_is_managing_user(id)
  );

create policy mst_user_select_admin on public."MST_User"
  for select to authenticated
  using (
    private.app_user_role() = 'admin'
    and organization_id = private.app_user_org_id()
  );

-- ---------------------------------------------------------------------
-- MST_UserInvitation — admin-only (contains crypto-random tokens). No
-- client insert/update: created by the admin invite route handler,
-- consumed by accept_invitation (SECURITY DEFINER, pre-auth anon key).
-- ---------------------------------------------------------------------

create policy mst_userinvitation_select_admin on public."MST_UserInvitation"
  for select to authenticated
  using (
    private.app_user_role() = 'admin'
    and organization_id = private.app_user_org_id()
  );

-- ---------------------------------------------------------------------
-- TIM_WorkArrangement — R all roles; W deferred to an admin RPC.
-- ---------------------------------------------------------------------

create policy tim_workarrangement_select on public."TIM_WorkArrangement"
  for select to authenticated
  using (organization_id = private.app_user_org_id());

-- ---------------------------------------------------------------------
-- TIM_WorkSession — own rows; manager reads managed-dept rows; admin
-- reads all. Writes via clock_in_user / clock_out_user /
-- admin_edit_locked_timecard (aal2) RPCs only.
-- ---------------------------------------------------------------------

create policy tim_worksession_select_own on public."TIM_WorkSession"
  for select to authenticated
  using (user_id = private.app_current_user_id() and organization_id = private.app_user_org_id());

create policy tim_worksession_select_managed on public."TIM_WorkSession"
  for select to authenticated
  using (
    private.app_user_role() = 'manager'
    and organization_id = private.app_user_org_id()
    and private.app_is_managing_user(user_id)
  );

create policy tim_worksession_select_admin on public."TIM_WorkSession"
  for select to authenticated
  using (
    private.app_user_role() = 'admin'
    and organization_id = private.app_user_org_id()
  );

-- ---------------------------------------------------------------------
-- TIM_CompensableBreak / TIM_NonCompensableBreak — same shape as
-- TIM_WorkSession, scoped via work_session_id. Writes via start_cb/end_cb
-- (or start_lb/end_lb) RPCs only.
-- ---------------------------------------------------------------------

create policy tim_compensablebreak_select_own on public."TIM_CompensableBreak"
  for select to authenticated
  using (
    organization_id = private.app_user_org_id()
    and work_session_id in (
      select id from public."TIM_WorkSession" where user_id = private.app_current_user_id()
    )
  );

create policy tim_compensablebreak_select_managed on public."TIM_CompensableBreak"
  for select to authenticated
  using (
    private.app_user_role() = 'manager'
    and organization_id = private.app_user_org_id()
    and private.app_is_managing_work_session(work_session_id)
  );

create policy tim_compensablebreak_select_admin on public."TIM_CompensableBreak"
  for select to authenticated
  using (
    private.app_user_role() = 'admin'
    and organization_id = private.app_user_org_id()
  );

create policy tim_noncompensablebreak_select_own on public."TIM_NonCompensableBreak"
  for select to authenticated
  using (
    organization_id = private.app_user_org_id()
    and work_session_id in (
      select id from public."TIM_WorkSession" where user_id = private.app_current_user_id()
    )
  );

create policy tim_noncompensablebreak_select_managed on public."TIM_NonCompensableBreak"
  for select to authenticated
  using (
    private.app_user_role() = 'manager'
    and organization_id = private.app_user_org_id()
    and private.app_is_managing_work_session(work_session_id)
  );

create policy tim_noncompensablebreak_select_admin on public."TIM_NonCompensableBreak"
  for select to authenticated
  using (
    private.app_user_role() = 'admin'
    and organization_id = private.app_user_org_id()
  );

-- ---------------------------------------------------------------------
-- TIM_CorrectionRequest — own rows; manager reads managed-dept rows;
-- admin reads all. Writes via submit/approve/reject_correction_request
-- (approve/reject are aal2) RPCs only.
-- ---------------------------------------------------------------------

create policy tim_correctionrequest_select_own on public."TIM_CorrectionRequest"
  for select to authenticated
  using (user_id = private.app_current_user_id() and organization_id = private.app_user_org_id());

create policy tim_correctionrequest_select_managed on public."TIM_CorrectionRequest"
  for select to authenticated
  using (
    private.app_user_role() = 'manager'
    and organization_id = private.app_user_org_id()
    and private.app_is_managing_user(user_id)
  );

create policy tim_correctionrequest_select_admin on public."TIM_CorrectionRequest"
  for select to authenticated
  using (
    private.app_user_role() = 'admin'
    and organization_id = private.app_user_org_id()
  );

-- ---------------------------------------------------------------------
-- TIM_SyncConflict — same shape as TIM_WorkSession (not explicit in the
-- §3.2 matrix; the offline-sync RPC surface lands in M6). Read-only here.
-- ---------------------------------------------------------------------

create policy tim_syncconflict_select_own on public."TIM_SyncConflict"
  for select to authenticated
  using (user_id = private.app_current_user_id() and organization_id = private.app_user_org_id());

create policy tim_syncconflict_select_managed on public."TIM_SyncConflict"
  for select to authenticated
  using (
    private.app_user_role() = 'manager'
    and organization_id = private.app_user_org_id()
    and private.app_is_managing_user(user_id)
  );

create policy tim_syncconflict_select_admin on public."TIM_SyncConflict"
  for select to authenticated
  using (
    private.app_user_role() = 'admin'
    and organization_id = private.app_user_org_id()
  );

-- ---------------------------------------------------------------------
-- MST_Holiday — R all roles; W deferred to an admin RPC. Not read by
-- anything else in this module (SPEC §3.1) but still org-scoped + RLS'd.
-- ---------------------------------------------------------------------

create policy mst_holiday_select on public."MST_Holiday"
  for select to authenticated
  using (organization_id = private.app_user_org_id());

-- ---------------------------------------------------------------------
-- AUD_SystemLog — admin read-only. No insert/update/delete policy for any
-- client role, ever: rows are written exclusively by
-- private.log_audit_event() (SECURITY DEFINER, bypasses RLS).
-- ---------------------------------------------------------------------

create policy aud_systemlog_select_admin on public."AUD_SystemLog"
  for select to authenticated
  using (
    private.app_user_role() = 'admin'
    and organization_id = private.app_user_org_id()
  );

-- ---------------------------------------------------------------------
-- MST_MfaBackupCode, RTL_RateLimitEvent — no client access at all (§3.2).
-- RLS is enabled (prior migrations) with zero policies for any role:
-- deliberately no CREATE POLICY here.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- NTF_Notification — recipients read + mark-read (is_read, read_at) own
-- rows only; inserts are server-side only (notification-emitting RPCs,
-- SECURITY DEFINER). Column-level grant restricts UPDATE to those two
-- columns regardless of role — every authenticated user gets the same
-- restriction here, so this doesn't need role branching like MST_User's
-- column limiting would.
-- ---------------------------------------------------------------------

create policy ntf_notification_select_own on public."NTF_Notification"
  for select to authenticated
  using (recipient_id = private.app_current_user_id() and organization_id = private.app_user_org_id());

create policy ntf_notification_update_own on public."NTF_Notification"
  for update to authenticated
  using (recipient_id = private.app_current_user_id() and organization_id = private.app_user_org_id())
  with check (recipient_id = private.app_current_user_id() and organization_id = private.app_user_org_id());

revoke update on public."NTF_Notification" from authenticated;
grant update (is_read, read_at) on public."NTF_Notification" to authenticated;
