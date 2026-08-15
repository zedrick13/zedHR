-- SPEC.md §3.1 support tables: MST_Holiday, AUD_SystemLog, MST_MfaBackupCode,
-- RTL_RateLimitEvent, NTF_Notification.

create table public."MST_Holiday" (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public."MST_Organization" (id),
  date date not null,
  name text not null,
  type text not null check (type in ('regular', 'special_non_working', 'custom')),
  region_scope text,
  created_at timestamptz not null default now()
);

create index idx_mst_holiday_organization_id on public."MST_Holiday" (organization_id);

alter table public."MST_Holiday" enable row level security;

-- Closed action_type registry (CLAUDE.md invariant #9): derived from every
-- RPC/job/feature named across SPEC.md §4/§6/§7/§8. SPEC.md §3.1 only gives
-- the shorthand "CLOCK_IN … DSAR_REQUEST_FULFILLED" pointing at the SRS for
-- the full list; this enumeration is the local source of truth until Zed
-- confirms it against SRS §3.1 (flagged in SPEC.md §11, not silently assumed).
create table public."AUD_SystemLog" (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public."MST_Organization" (id),
  actor_id uuid references public."MST_User" (id),
  -- Polymorphic (session, correction request, user, ...) — no single FK target.
  target_id uuid,
  action_type text not null check (
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
      'RATE_LIMIT_TRIGGERED'
    )
  ),
  previous_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);

create index idx_aud_systemlog_organization_id on public."AUD_SystemLog" (organization_id);
create index idx_aud_systemlog_actor_id on public."AUD_SystemLog" (actor_id);
create index idx_aud_systemlog_action_type on public."AUD_SystemLog" (action_type);

-- Append-only: RLS is enabled with an admin-only SELECT policy (added in the
-- RLS policies migration) and deliberately no INSERT/UPDATE/DELETE policy
-- for any client role. Rows are written exclusively by the log_audit_event()
-- SECURITY DEFINER helper, which bypasses RLS as the table owner.
alter table public."AUD_SystemLog" enable row level security;

create table public."MST_MfaBackupCode" (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public."MST_Organization" (id),
  user_id uuid not null references public."MST_User" (id),
  code_hash text not null,
  is_used boolean not null default false,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_mst_mfabackupcode_user_id on public."MST_MfaBackupCode" (user_id);

-- No client access at all (SPEC §3.2): RLS enabled, no policies for any
-- client role. Only SECURITY DEFINER RPCs (MFA enroll/challenge/reset) touch it.
alter table public."MST_MfaBackupCode" enable row level security;

create table public."RTL_RateLimitEvent" (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: pre-auth buckets (login:{email}, invitation_accept:{token})
  -- have no authenticated user or resolved org yet.
  organization_id uuid references public."MST_Organization" (id),
  user_id uuid references public."MST_User" (id),
  bucket_key varchar not null,
  created_at timestamptz not null default now()
);

create index idx_rtl_ratelimitevent_bucket_key_created_at on public."RTL_RateLimitEvent" (bucket_key, created_at);

-- No client access at all (SPEC §3.2): only check_rate_limit() (SECURITY
-- DEFINER) reads/writes this table.
alter table public."RTL_RateLimitEvent" enable row level security;

create table public."NTF_Notification" (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public."MST_Organization" (id),
  recipient_id uuid not null references public."MST_User" (id),
  template text not null check (template in ('B', 'C', 'D', 'E', 'G')),
  -- Server-interpolated at insert; immutable thereafter (SPEC §3.1).
  title text not null,
  body text not null,
  link_path text,
  dedupe_key text,
  is_read boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_ntf_notification_recipient_unread on public."NTF_Notification" (recipient_id, is_read);
create index idx_ntf_notification_dedupe_key on public."NTF_Notification" (dedupe_key, created_at);

alter table public."NTF_Notification" enable row level security;
alter publication supabase_realtime add table public."NTF_Notification";
