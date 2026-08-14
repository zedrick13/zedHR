-- SPEC.md §3.1 timekeeping tables. organization_id is added to every table
-- here even where the abbreviated §3.1 bullet omitted it, per CLAUDE.md
-- forward-compat rule #1 ("organization_id on every domain table").

create table public."TIM_WorkArrangement" (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public."MST_Organization" (id),
  target_level text not null check (target_level in ('organization', 'department', 'user', 'day')),
  -- Polymorphic target (org/department/user id, or a user+day composite
  -- resolved in application logic) — no single FK target is possible.
  target_id uuid not null,
  arrangement text not null check (arrangement in ('office', 'wfh', 'hybrid')),
  effective_date date not null,
  expires_date date,
  created_at timestamptz not null default now(),
  constraint chk_work_arrangement_dates check (expires_date is null or expires_date >= effective_date)
);

create index idx_tim_workarrangement_organization_id on public."TIM_WorkArrangement" (organization_id);
create index idx_tim_workarrangement_target on public."TIM_WorkArrangement" (target_level, target_id);

alter table public."TIM_WorkArrangement" enable row level security;

create table public."TIM_WorkSession" (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public."MST_User" (id),
  organization_id uuid not null references public."MST_Organization" (id),
  clock_in_time timestamptz not null,
  clock_out_time timestamptz,
  clock_in_ip inet,
  clock_out_ip inet,
  clock_in_geo_status text not null check (clock_in_geo_status in ('checked', 'unavailable', 'denied')),
  clock_out_geo_status text check (clock_out_geo_status in ('checked', 'unavailable', 'denied')),
  clock_in_lat double precision,
  clock_in_lng double precision,
  clock_out_lat double precision,
  clock_out_lng double precision,
  clock_in_outside_boundary boolean not null default false,
  clock_out_outside_boundary boolean not null default false,
  flagged_long_running boolean not null default false,
  created_at timestamptz not null default now(),
  constraint chk_work_session_times check (clock_out_time is null or clock_out_time > clock_in_time)
);

create index idx_tim_worksession_organization_id on public."TIM_WorkSession" (organization_id);
create index idx_tim_worksession_user_id on public."TIM_WorkSession" (user_id);

-- CLAUDE.md invariant #4: one open session per user, enforced by the DB,
-- not application checks alone.
create unique index idx_open_work_session on public."TIM_WorkSession" (user_id) where (clock_out_time is null);

alter table public."TIM_WorkSession" enable row level security;

create table public."TIM_CompensableBreak" (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public."MST_Organization" (id),
  work_session_id uuid not null references public."TIM_WorkSession" (id),
  start_time timestamptz not null,
  end_time timestamptz,
  is_auto_closed boolean not null default false,
  policy_violation boolean not null default false,
  -- CB rows only ever violate on overtime (SPEC §3.1); tightened from the
  -- combined CB_OVERTIME|LB_SHORT check to the value this table can produce.
  policy_violation_reason text check (policy_violation_reason in ('CB_OVERTIME')),
  created_at timestamptz not null default now(),
  constraint chk_cb_times check (end_time is null or end_time > start_time)
);

create index idx_tim_compensablebreak_organization_id on public."TIM_CompensableBreak" (organization_id);
create index idx_tim_compensablebreak_work_session_id on public."TIM_CompensableBreak" (work_session_id);

-- Mirrors idx_open_work_session's rationale (CLAUDE.md #4): at most one
-- open break per session, enforced by the DB alongside the RPC's own check.
create unique index idx_open_cb on public."TIM_CompensableBreak" (work_session_id) where (end_time is null);

alter table public."TIM_CompensableBreak" enable row level security;

create table public."TIM_NonCompensableBreak" (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public."MST_Organization" (id),
  work_session_id uuid not null references public."TIM_WorkSession" (id),
  start_time timestamptz not null,
  end_time timestamptz,
  is_auto_closed boolean not null default false,
  policy_violation boolean not null default false,
  -- LB rows only ever violate on being too short (SPEC §3.1).
  policy_violation_reason text check (policy_violation_reason in ('LB_SHORT')),
  created_at timestamptz not null default now(),
  constraint chk_lb_times check (end_time is null or end_time > start_time)
);

create index idx_tim_noncompensablebreak_organization_id on public."TIM_NonCompensableBreak" (organization_id);
create index idx_tim_noncompensablebreak_work_session_id on public."TIM_NonCompensableBreak" (work_session_id);

create unique index idx_open_lb on public."TIM_NonCompensableBreak" (work_session_id) where (end_time is null);

alter table public."TIM_NonCompensableBreak" enable row level security;

create table public."TIM_CorrectionRequest" (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public."MST_User" (id),
  organization_id uuid not null references public."MST_Organization" (id),
  work_session_id uuid references public."TIM_WorkSession" (id),
  request_type text not null check (
    request_type in ('clock_in', 'clock_out', 'cb_start', 'cb_end', 'lb_start', 'lb_end', 'create_session')
  ),
  requested_timestamp timestamptz not null,
  -- RPC enforces the toast-safe ERR_VALIDATION message (SPEC §4); this CHECK
  -- is a data-integrity backstop, not the primary UX path.
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public."MST_User" (id),
  reviewed_at timestamptz,
  rejection_note text check (rejection_note is null or char_length(rejection_note) <= 500),
  created_at timestamptz not null default now()
);

create index idx_tim_correctionrequest_organization_id on public."TIM_CorrectionRequest" (organization_id);
create index idx_tim_correctionrequest_user_id on public."TIM_CorrectionRequest" (user_id);
create index idx_tim_correctionrequest_status on public."TIM_CorrectionRequest" (status);

alter table public."TIM_CorrectionRequest" enable row level security;

create table public."TIM_SyncConflict" (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public."MST_Organization" (id),
  user_id uuid not null references public."MST_User" (id),
  work_session_id uuid references public."TIM_WorkSession" (id),
  failed_action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_tim_syncconflict_organization_id on public."TIM_SyncConflict" (organization_id);
create index idx_tim_syncconflict_user_id on public."TIM_SyncConflict" (user_id);

alter table public."TIM_SyncConflict" enable row level security;
