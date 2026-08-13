-- Bootstrap smoke-test fixture (M0). Not part of the domain schema — proves
-- the RPC round-trip (client -> PostgREST -> Postgres -> callRpc()) before
-- M1 lands the real tables. Safe to keep: harmless, stable, exercised by
-- tests/callRpc.test.ts.
create function public.ping()
returns text
language sql
stable
as $$
  select 'pong';
$$;
