-- SPEC.md §9 invariant #7/#8/#9: rate-limit-first checks and audit inserts,
-- centralized so every guarded RPC calls the same two helpers instead of
-- re-implementing the sliding-window count / insert logic. Both live in the
-- `private` schema (see 20260814000006) so they're usable from RPCs but not
-- directly callable as a client RPC.

create or replace function private.log_audit_event(
  p_organization_id uuid,
  p_actor_id uuid,
  p_target_id uuid,
  p_action_type text,
  p_previous_value jsonb default null,
  p_new_value jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public."AUD_SystemLog" (organization_id, actor_id, target_id, action_type, previous_value, new_value)
  values (p_organization_id, p_actor_id, p_target_id, p_action_type, p_previous_value, p_new_value)
  returning id into v_id;

  return v_id;
end;
$$;

-- Sliding-window count over RTL_RateLimitEvent (SPEC §6). Counts existing
-- events in the window BEFORE inserting: a breach returns false without
-- adding a row, so a flood of denied attempts doesn't inflate the window.
-- Callers are responsible for logging RATE_LIMIT_TRIGGERED and raising
-- ERR_RATE_LIMITED on a false return (SPEC §6 "Every breach → AUD_SystemLog
-- RATE_LIMIT_TRIGGERED").
create or replace function private.check_rate_limit(
  p_bucket_key text,
  p_max_count integer,
  p_window interval,
  p_user_id uuid default null,
  p_organization_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public."RTL_RateLimitEvent"
  where bucket_key = p_bucket_key
    and created_at > (now() - p_window);

  if v_count >= p_max_count then
    return false;
  end if;

  insert into public."RTL_RateLimitEvent" (organization_id, user_id, bucket_key)
  values (p_organization_id, p_user_id, p_bucket_key);

  return true;
end;
$$;
