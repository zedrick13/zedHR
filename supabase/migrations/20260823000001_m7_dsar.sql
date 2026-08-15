-- SPEC.md M7: DSAR intake/fulfillment (§8.3, RA 10173).
--
-- SPEC names the RPC signatures directly (§4's RLS/RPC table:
-- "log_dsar_request(user_id, type, notes) / resolve_dsar_request(id)",
-- both "admin; aal2") and the two audit action types
-- (DSAR_REQUEST_LOGGED/DSAR_REQUEST_FULFILLED, already in M1's registry)
-- and Template G, but never defines a backing table anywhere in §3.1's
-- table list — MST_DSARRequest below is new, following the same
-- conventions (organization_id FK, id/created_at shape) as every other
-- table in this schema.

create table public."MST_DSARRequest" (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public."MST_Organization" (id),
  user_id uuid not null references public."MST_User" (id),
  request_type text not null check (request_type in ('access', 'erasure')),
  notes text,
  -- 'declined' is reachable only for an 'erasure' request resolved while
  -- the subject is still an active employee (legal-retention exemption,
  -- SPEC §8.3) — not a status either RPC accepts as a direct input.
  status text not null default 'pending' check (status in ('pending', 'resolved', 'declined')),
  resolved_by uuid references public."MST_User" (id),
  resolved_at timestamptz,
  resolution_note text,
  logged_by uuid not null references public."MST_User" (id),
  created_at timestamptz not null default now()
);

create index idx_mst_dsarrequest_organization_id on public."MST_DSARRequest" (organization_id);
create index idx_mst_dsarrequest_user_id on public."MST_DSARRequest" (user_id);

alter table public."MST_DSARRequest" enable row level security;

-- Admin-only, matching MST_Organization/MST_Department's "R all roles;
-- W deferred to RPC" shape but restricted to admin-read too, since a DSAR
-- request's existence and notes are themselves compliance-sensitive —
-- not something SPEC's RLS matrix lists a manager/employee row for.
create policy mst_dsarrequest_select_admin on public."MST_DSARRequest"
  for select to authenticated
  using (
    private.app_user_role() = 'admin'
    and organization_id = private.app_user_org_id()
  );

create or replace function public.log_dsar_request(
  p_user_id uuid,
  p_type text,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid;
  v_target_org_id uuid;
  v_dsar_id uuid;
  v_admin_id uuid;
begin
  perform private.require_admin_write();

  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;
  select organization_id into v_target_org_id from public."MST_User" where id = p_user_id;

  if v_target_org_id is null or v_target_org_id <> v_org_id then
    raise exception 'USER_NOT_FOUND';
  end if;
  if p_type not in ('access', 'erasure') then
    raise exception 'ERR_VALIDATION';
  end if;
  if p_notes is not null and char_length(p_notes) > 1000 then
    raise exception 'ERR_VALIDATION';
  end if;

  insert into public."MST_DSARRequest" (organization_id, user_id, request_type, notes, logged_by)
  values (v_org_id, p_user_id, p_type, p_notes, v_actor_id)
  returning id into v_dsar_id;

  perform private.log_audit_event(v_org_id, v_actor_id, v_dsar_id, 'DSAR_REQUEST_LOGGED', null,
    jsonb_build_object('request_type', p_type, 'subject_user_id', p_user_id));

  -- Template G: every other admin, for compliance oversight/visibility —
  -- SPEC names the template but not its recipient; inferred as "the rest
  -- of the admin team should know a DSAR request came in," flagged in
  -- SPEC.md as an interpretation.
  for v_admin_id in
    select id from public."MST_User"
    where organization_id = v_org_id and role = 'admin' and id <> v_actor_id
  loop
    perform private.create_notification(v_org_id, v_admin_id, 'G',
      'DSAR request logged',
      'A ' || p_type || ' request was logged and needs review.',
      '/admin/dsar');
  end loop;

  return v_dsar_id;
end;
$$;

create or replace function public.resolve_dsar_request(
  p_dsar_id uuid,
  p_resolution_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid;
  v_request record;
  v_subject_terminated_at timestamptz;
  v_final_status text;
begin
  perform private.require_admin_write();

  select organization_id into v_org_id from public."MST_User" where id = v_actor_id;

  select * into v_request from public."MST_DSARRequest"
    where id = p_dsar_id and organization_id = v_org_id;
  if v_request.id is null then
    raise exception 'DSAR_REQUEST_NOT_FOUND';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'DSAR_REQUEST_ALREADY_RESOLVED';
  end if;
  if p_resolution_note is not null and char_length(p_resolution_note) > 1000 then
    raise exception 'ERR_VALIDATION';
  end if;

  if v_request.request_type = 'erasure' then
    select terminated_at into v_subject_terminated_at
      from public."MST_User" where id = v_request.user_id;

    if v_subject_terminated_at is null then
      -- SPEC §8.3: "erasure for active employees is declined per
      -- legal-retention exemption."
      v_final_status := 'declined';
    else
      -- SPEC §8.3: "...for terminated employees triggers force_anonymize_user."
      perform private.anonymize_user(v_request.user_id);
      v_final_status := 'resolved';
    end if;
  else
    v_final_status := 'resolved';
  end if;

  update public."MST_DSARRequest"
    set status = v_final_status,
        resolved_by = v_actor_id,
        resolved_at = now(),
        resolution_note = p_resolution_note
    where id = p_dsar_id;

  perform private.log_audit_event(v_org_id, v_actor_id, p_dsar_id, 'DSAR_REQUEST_FULFILLED',
    jsonb_build_object('status', 'pending'), jsonb_build_object('status', v_final_status));
end;
$$;

revoke execute on function public.log_dsar_request from public, anon;
revoke execute on function public.resolve_dsar_request from public, anon;
grant execute on function public.log_dsar_request to authenticated;
grant execute on function public.resolve_dsar_request to authenticated;
