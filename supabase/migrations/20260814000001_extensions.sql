-- pgcrypto: gen_random_uuid() default PKs (SPEC §3) and crypt()/gen_salt()
-- for bcrypt hashing (MST_MfaBackupCode.code_hash, invitation tokens).
create extension if not exists pgcrypto with schema extensions;

-- CLAUDE.md invariant #1: "RLS is the security boundary." Table-level GRANTs
-- are deliberately permissive here (base object privilege, not row access);
-- every table created in this and later migrations enables RLS with its own
-- policies, which is what actually restricts access. This local Postgres
-- image doesn't pre-grant table privileges to anon/authenticated/service_role
-- the way a provisioned Supabase project does, so every table created by the
-- migration-running role from this point on inherits these defaults.
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;

alter default privileges in schema public
  grant all on tables to service_role;

alter default privileges in schema public
  grant execute on functions to service_role;

grant usage on schema public to anon, authenticated, service_role;
