# zedHR Timekeeping

Timekeeping module for one organization (~50 employees): clock in/out, paid short breaks (CB), unpaid lunch breaks (LB), correction requests, and a manager dashboard. See `SPEC.md` for the full specification and `CLAUDE.md` for project conventions.

## Stack

Next.js (App Router, TypeScript) on Vercel + Supabase (Postgres, Auth, Storage, Edge Functions, Realtime, pg_cron). See `CLAUDE.md` for the full list of what's in and out of scope.

## Getting started

```bash
pnpm install
supabase start          # local Supabase stack (requires Docker)
supabase db reset        # apply migrations + seed
cp .env.example .env.local   # fill in all three vars from `supabase status` (anon + service-role key)
pnpm dev
```

## Commands

```bash
pnpm dev                 # Next.js dev server
supabase start           # local stack (Docker)
supabase db reset        # rebuild local DB from migrations + seed
supabase db push         # apply migrations to linked project (deliberate, manual)
pnpm supabase:gen-types   # regenerate lib/database.types.ts from the local stack
pnpm test                 # Vitest (unit + RLS tests against local supabase)
pnpm test:e2e              # Playwright
pnpm lint && pnpm typecheck
```

## Seeding the first admin

Manual-run only, never wired into deploy:

```bash
SUPABASE_SERVICE_ROLE_KEY=... NEXT_PUBLIC_SUPABASE_URL=... \
  pnpm tsx scripts/seed-first-admin.ts --email admin@example.com --name "Ada Lovelace"
```

## Status

Milestone progress is tracked in `SPEC.md` §10. Currently complete: M0 (repo/tooling scaffold), M1 (schema & RLS foundation), M2 (auth, invitations, MFA), M3 (core timekeeping loop), M4 (corrections workflow), M5 (notifications & manager dashboard), M6 (offline queue & sync).
