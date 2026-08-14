-- SPEC.md §2.4: RLS policies call SQL helper functions reading JWT claims,
-- so tenant-scoping changes happen in one place per concern (Phase 1
-- multi-tenant forward-compat).
--
-- These live in a `private` schema (not `public`) deliberately: PostgREST
-- only exposes schemas listed in supabase/config.toml's [api] schemas
-- (public, graphql_public), so functions here are usable inside RLS policies
-- (a normal EXECUTE grant, unrelated to PostgREST routing) without being
-- directly callable as a client RPC. Revoking EXECUTE from `authenticated`
-- instead would have broken the RLS policies that call them.
create schema if not exists private;
grant usage on schema private to authenticated, anon;

create or replace function private.app_current_user_id()
returns uuid
language sql
stable
as $$
  select auth.uid();
$$;

create or replace function private.app_user_org_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'organization_id', '')::uuid;
$$;

-- NOTE: the custom claim is named `user_role`, not `role`. Supabase's JWT
-- already has a top-level `role` claim that PostgREST uses to pick the
-- Postgres connection role (anon/authenticated); overwriting it with our
-- employee/manager/admin value would break auth for every request. SPEC.md's
-- "role" claim wording refers to the data being carried, not this literal
-- JSON key — documented in SPEC.md next to this migration.
create or replace function private.app_user_role()
returns text
language sql
stable
as $$
  select auth.jwt() ->> 'user_role';
$$;

create or replace function private.app_is_aal2()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

-- SPEC.md §7 "Sessions": role changes force re-login. The custom access
-- token hook stamps role_changed_at into the JWT at mint time; this compares
-- that snapshot to the live MST_User row so a token minted before the most
-- recent role change is rejected for privileged writes. SECURITY DEFINER
-- (runs as table owner) so it doesn't recurse into MST_User's own RLS.
create or replace function private.app_role_is_current()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (auth.jwt() ->> 'role_changed_at')::timestamptz >= (
      select u.role_changed_at from public."MST_User" u where u.id = auth.uid()
    ),
    false
  );
$$;

-- Convenience predicates for the aal2-gated manager/admin write policies
-- (SPEC §3.2 "MFA gate": reads are never aal2-gated, employee writes never
-- aal2-gated).
create or replace function private.app_is_manager_write_allowed()
returns boolean
language sql
stable
as $$
  select private.app_is_aal2()
    and private.app_role_is_current()
    and private.app_user_role() in ('manager', 'admin');
$$;

create or replace function private.app_is_admin_write_allowed()
returns boolean
language sql
stable
as $$
  select private.app_is_aal2()
    and private.app_role_is_current()
    and private.app_user_role() = 'admin';
$$;

-- Custom Access Token Hook (registered in supabase/config.toml). Stamps
-- organization_id / user_role / role_changed_at onto the JWT at mint time.
-- Stays in `public` (GoTrue calls it directly, not through PostgREST) and
-- follows Supabase's documented lockdown: only supabase_auth_admin may call it.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims jsonb;
  profile record;
begin
  claims := event -> 'claims';

  select organization_id, role, role_changed_at
    into profile
    from public."MST_User"
    where id = (event ->> 'user_id')::uuid;

  if profile is null then
    -- No profile yet (e.g. between auth.users creation and MST_User
    -- provisioning) — leave claims untouched.
    return event;
  end if;

  claims := jsonb_set(claims, '{organization_id}', to_jsonb(profile.organization_id::text));
  claims := jsonb_set(claims, '{user_role}', to_jsonb(profile.role));
  claims := jsonb_set(claims, '{role_changed_at}', to_jsonb(profile.role_changed_at));

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
