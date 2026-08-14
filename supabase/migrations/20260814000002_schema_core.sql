-- SPEC.md §3.1 core tables: MST_Organization, MST_Department, MST_User,
-- MST_UserInvitation. RLS is enabled here with zero policies (deny-all by
-- default, CLAUDE.md invariant #1); actual policies land once the JWT
-- helper functions exist, in a later migration in this same PR.

create table public."MST_Organization" (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Asia/Manila',
  -- No default given in SRS; en-PH matches the target market (SPEC §9 "Dates in UI").
  display_locale text not null default 'en-PH',
  pay_cycle_type text not null check (pay_cycle_type in ('weekly', 'biweekly', 'monthly')),
  pay_cycle_start_date date not null default current_date,
  geofence_latitude double precision,
  geofence_longitude double precision,
  geofence_radius_m integer,
  max_cb_minutes integer not null default 20,
  -- SPEC §11 item 4: SRS gives no default; using the SPEC's own proposal of
  -- 30 pending explicit confirmation from Zed (flagged, not silently assumed).
  min_lb_minutes integer not null default 30,
  data_retention_days integer not null default 365,
  created_at timestamptz not null default now()
);

alter table public."MST_Organization" enable row level security;

create table public."MST_Department" (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public."MST_Organization" (id),
  name text not null,
  -- FK to MST_User added after that table exists (circular dependency).
  manager_id uuid,
  created_at timestamptz not null default now()
);

create index idx_mst_department_organization_id on public."MST_Department" (organization_id);

alter table public."MST_Department" enable row level security;

create table public."MST_User" (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references public."MST_Organization" (id),
  department_id uuid references public."MST_Department" (id),
  first_name text not null,
  last_name text not null,
  role text not null check (role in ('employee', 'manager', 'admin')),
  is_active boolean not null default true,
  mfa_enrolled boolean not null default false,
  avatar_path text,
  terminated_at timestamptz,
  scheduled_purge_at timestamptz,
  -- SPEC §7 "Sessions": role changes force re-login; this marker is checked
  -- by the aal2-gated RLS policies (§8 helper migration). Not in the
  -- abbreviated §3.1 bullet list — added here and documented in SPEC.md.
  role_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index idx_mst_user_organization_id on public."MST_User" (organization_id);
create index idx_mst_user_department_id on public."MST_User" (department_id);

alter table public."MST_User" enable row level security;

alter table public."MST_Department"
  add constraint fk_department_manager foreign key (manager_id) references public."MST_User" (id);

create table public."MST_UserInvitation" (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public."MST_Organization" (id),
  email text not null,
  role text not null check (role in ('employee', 'manager', 'admin')),
  token text not null unique default encode(extensions.gen_random_bytes(32), 'hex'),
  expires_at timestamptz not null default (now() + interval '7 days'),
  is_used boolean not null default false,
  revoked_at timestamptz,
  revoked_by uuid references public."MST_User" (id),
  invited_by uuid not null references public."MST_User" (id),
  created_at timestamptz not null default now(),
  unique (organization_id, email)
);

create index idx_mst_userinvitation_organization_id on public."MST_UserInvitation" (organization_id);

alter table public."MST_UserInvitation" enable row level security;
