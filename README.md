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

## Go-live checklist

Everything in this checklist that doesn't require the operator's own accounts/credentials has been implemented and verified against the local stack. What's left is either a real external-account step (nobody but the operator can do this) or a re-verification pass that can only happen against a real deployed project (this sandbox has no live Vercel/Supabase-hosted project or non-Chromium browsers to test against). See `SPEC.md` §11 for the full, numbered list of flagged items — this section is the launch-day sequencing.

**Done, verified against the local stack (nothing further needed here):**

- Every RPC, RLS policy, and migration in `supabase/migrations/` — `supabase db reset` applies cleanly from scratch, repeatedly confirmed.
- Full test suite: 135 Vitest tests (unit + RLS) and 14 Playwright e2e specs, all passing, re-run after every milestone's changes including this one.
- Security pass: no service-role key in the client bundle (grepped `.next/static` directly), no secrets/PII in any `console.*`/`RAISE NOTICE` call site, every error code has a toast-safe message enforced by TypeScript, Storage prefixes locked by RLS.
- a11y pass: coral reserved for filled elements only (never body text), global `focus-visible` and `prefers-reduced-motion` coverage confirmed, 44px minimum hit targets on every interactive element.
- Rate-limit sweep: every §6 bucket has a passing trip test asserting both the 429 and the `RATE_LIMIT_TRIGGERED` audit row (this surfaced and fixed a real bug — see `SPEC.md`'s M8 notes).
- Forward-compat audit: every `organization_id` access path traced to `getCurrentOrgId()`/`app_user_org_id()`.
- Perf pass: skeleton loading UI added for every route (>300ms threshold), every animation confirmed transform/opacity-only, punch latency re-measured through the real client path (well under the 500ms target locally).
- Backup workflow + a real, executed restore drill (see above).

**Needs a real deployed environment to re-verify (can't be done from this sandbox):**

1. **Browser matrix** (last 2 versions: Chrome/Edge/Safari/Firefox, desktop + mobile). This sandbox has Chromium only — no Firefox, no WebKit/Safari engine, no real mobile browsers — so the full Playwright suite has only ever run against Chromium. A code-level review found no actual risk spots: the one CSS feature SPEC explicitly flags (`backdrop-filter`, via the `--blur-bar` token) is defined but not currently applied to anything, so there's nothing to add a fallback for yet; `color-mix()` (badges/status backgrounds) and `100dvh` (full-height auth screens) are both supported by every browser's last 2 versions as of writing and degrade gracefully (an unsupported `color-mix()` value is simply ignored, not a hard failure) — but this is a paper review, not a real cross-browser test pass, and needs one before launch.
2. **`get_avatar_upload_url` Edge Function** — `supabase functions serve` can't run in this sandbox (container-runtime privilege error). Storage RLS, the persist-path RPC, and client-side validation are all tested directly; the function's actual deploy/execution/signed-URL-minting/rate-limit path needs a real pass.
3. **The backup restore drill's `auth`-schema portion** — verified for `public`-schema data; the `auth` portion needs the same drill run against a real (or realistically GoTrue-provisioned) project.
4. **The M8 rate-limit fix's `dblink` loopback connection** — works against local Supabase's dev `pg_hba.conf`; the design (password auth over whatever address the connection actually arrived on) should generalize to a hosted project's network posture, but hasn't been confirmed against one.
5. **pg_cron's `02:00 Asia/Manila` schedule** assumes the deployed Postgres server's own timezone is UTC — checked directly against local, needs the same check against the real project.
6. **Punch p95** — re-measured locally (min 19.0ms / p50 22.0ms / max 49.4ms through the real PostgREST path), comfortably under the <500ms target, but the actual AC is a measurement from a real Singapore-hosted project over a PH network, which this sandbox can't produce.

**Needs the operator's own accounts/credentials (the actual launch steps, in order):**

1. Confirm the Vercel plan — Hobby is non-commercial; Pro (~US$20/mo) is the compliant baseline for this use case (`SPEC.md` §11 item 1).
2. Provision the hosted Supabase project (Singapore region per SPEC §2.1).
3. `supabase link` this repo to that project, then `supabase db push` to apply every migration.
4. Set the production env vars in Vercel (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — server-side only, never `NEXT_PUBLIC_*`).
5. Set the four backup-workflow repo secrets in GitHub Actions (`SUPABASE_DB_URL`, `BACKUP_GPG_PUBLIC_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) — generate the GPG keypair offline and keep the private key + passphrase outside GitHub entirely, per CLAUDE.md.
6. Connect Vercel's Git integration to this repo (deploys on push to `main`, previews on PRs — no separate deploy workflow to write).
7. Attach `zedhr.com` / `www.zedhr.com` via Namecheap DNS records to the Vercel project.
8. Run `scripts/seed-first-admin.ts` once against the production project to create the first org + admin account (manual-run only, never wired into deploy).
9. Work through the "needs a real deployed environment" list above against the now-live project, closing out `SPEC.md` §11's numbered items as each is confirmed.

## Status

Milestone progress is tracked in `SPEC.md` §10. Currently complete: M0 (repo/tooling scaffold), M1 (schema & RLS foundation), M2 (auth, invitations, MFA), M3 (core timekeeping loop), M4 (corrections workflow), M5 (notifications & manager dashboard), M6 (offline queue & sync), M7 (pg_cron jobs, anonymization/DSAR compliance, avatar upload, admin config screens), M8 (hardening: backups, rate-limit sweep, security/a11y/perf/forward-compat passes). See `SPEC.md` §11 and the go-live checklist above for what's left before the real launch.
