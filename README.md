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

## Backups & restore drill

`.github/workflows/backup.yml` is the one sanctioned GitHub Actions workflow (CLAUDE.md): weekly, gpg-encrypted (asymmetric — only a public key is a repo secret; the private key + passphrase are held by the operator, never in GitHub), uploaded to both a 90-day GitHub Actions artifact and the private Supabase `backups` Storage bucket, with a prune step (`scripts/prune-old-backups.ts`) removing bucket copies older than 90 days.

The dump is **data-only**, scoped to `public` (our own schema) plus the `auth.users`/`auth.identities`/`auth.mfa_factors`/`auth.mfa_amr_claims` identity tables — not a full cluster dump. A restore target (the same project recovering from an incident, or a freshly provisioned replacement) already has its platform schemas (`auth`, `storage`, `extensions`, `cron`, `realtime`) created and version-managed by Supabase; a full dump's schema DDL for those collides with what's already there. Our own schema is instead recreated from source (`supabase db push`, i.e. this repo's migrations) before the data dump is loaded.

**Restore procedure:**

1. Provision (or use the existing, post-incident) Supabase project.
2. `supabase link` + `supabase db push` — recreates `public`/`private` schema, RPCs, RLS policies, and the `avatars`/`backups` Storage buckets from this repo's migrations.
3. Decrypt the backup: `gpg --decrypt -o backup.sql backup.sql.gpg` (requires the offline private key).
4. Load it: `psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f backup.sql`, connected as a role with superuser privileges (needed for `--disable-triggers`, which the dump requires to load through one genuine circular FK: `MST_Department.manager_id` ↔ `MST_User.department_id`).

**Drill executed 2026-08-15** against the local stack, end to end, not just described: generated a throwaway GPG keypair, encrypted a real dump, confirmed the decrypted file byte-identical to the original, applied this repo's migrations to an isolated fresh Postgres instance (same image/version, simulating a newly provisioned project), loaded the data-only dump, and verified every `public`-schema table's row count and content matched the source exactly (organization name, user identity fields, UUIDs — all identical post-restore). The `auth` schema's portion of the dump was written and included in the real workflow but couldn't be drill-verified in this sandbox: the isolated test instance was a bare Postgres image without Supabase's Auth service actually running its own schema migrations against it, so its `auth.users` table's column set didn't line up with the live instance's GoTrue-migrated version — an artifact of the drill's own methodology (no way to run a second live `auth` service in this sandbox), not a defect in the backup content. This is flagged as a real open item to re-verify against an actual deployed environment before launch (SPEC.md §11).

## Status

Milestone progress is tracked in `SPEC.md` §10. Currently complete: M0 (repo/tooling scaffold), M1 (schema & RLS foundation), M2 (auth, invitations, MFA), M3 (core timekeeping loop), M4 (corrections workflow), M5 (notifications & manager dashboard), M6 (offline queue & sync), M7 (pg_cron jobs, anonymization/DSAR compliance, avatar upload, admin config screens). See `SPEC.md` §11 for open items to close before M8 launch.
