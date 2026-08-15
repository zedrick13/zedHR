-- SPEC.md §7 "Provisioning": 50-user cap enforced by insert trigger, not
-- application checks alone (CLAUDE.md invariant #12, deliberate hardcoded limit).
create or replace function public.enforce_user_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
begin
  select count(*) into current_count
  from public."MST_User"
  where organization_id = new.organization_id;

  if current_count >= 50 then
    raise exception 'ERR_USER_LIMIT_EXCEEDED';
  end if;

  return new;
end;
$$;

create trigger trg_enforce_user_limit
  before insert on public."MST_User"
  for each row
  execute function public.enforce_user_limit();
