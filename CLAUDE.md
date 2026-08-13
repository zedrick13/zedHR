# CLAUDE.md — zedHR Timekeeping

Project memory for Claude Code. Read this before any task. The authoritative requirements live in `SPEC.md` (derived from ZedHR SRS v7); when this file and SPEC.md conflict, SPEC.md wins and this file must be updated.

## What this project is

zedHR Timekeeping Module: a web app for one organization (~50 employees) to record work shifts, paid short breaks (CB), unpaid lunch breaks (LB), and corrections to those records — audit-compliant under PH Data Privacy Act (RA 10173).

**Scope boundary (do not drift):** this module tracks *elapsed worked time only*. It never computes pay, overtime premiums, night differential, or any pay-rate-dependent value. Payroll, Leave, and ESS are future modules. If a task seems to require pay computation, stop and flag it.

**Forward-compatibility mandate:** the code is single-org today but must not block the Phase 1 multi-tenant zedHR (subdomain-per-tenant SaaS). Follow the rules in SPEC.md §2.4 — `organization_id` on every domain table, org resolution behind one helper, no `WHERE` clause that assumes exactly one org exists.

## Stack (exactly three platforms — do not add services)

| Layer | Choice |
|---|---|
| Repo / CI | GitHub. GitHub Actions runs ONLY the weekly encrypted pg_dump backup workflow. |
| Frontend/hosting | Next.js (App Router, TypeScript) on Vercel. Functions pinned to `sin1`. |
| Backend | Supabase: Postgres, Auth, Storage, Edge Functions, Realtime, pg_cron. |

Never introduce: AWS anything, Resend or any email/SMS provider, Redis, external schedulers, analytics SDKs, ORMs (use SQL migrations + generated types). Auth email (invites, password reset) goes through Supabase Auth's built-in mailer only. All other notifications are in-app rows in `NTF_Notification`.

## Repo layout

```
/app                  Next.js App Router routes
/components/ui        Design-system primitives ONLY (Button, Card, Sheet, ListRow, ...)
/components/features  Feature components composed from /components/ui
/lib                  callRpc(), supabase clients, org resolution, utils
/lib/offline          punch queue + sync worker
/supabase/migrations  SQL migrations (schema, RLS, RPCs, triggers, pg_cron)
/supabase/functions   Edge Functions (get_avatar_upload_url)
/styles/tokens.css    ALL design tokens; components never hardcode values
/tests                Vitest unit + RLS tests; /tests/e2e Playwright
```

## Non-negotiable invariants

1. **RLS is the security boundary.** Next.js middleware redirects (`/login`, `/mfa`) are UX only. Every table has RLS enabled from the migration that creates it. Never ship a table without policies; never use the service-role key in client-reachable code.
2. **All writes go through Postgres RPCs** (`supabase.rpc(...)`). No direct `.insert()/.update()/.delete()` from the client. Reads may use PostgREST selects under RLS.
3. **Server time is authoritative.** Clock events use `NOW()` server-side. Client timestamps appear only in the offline queue's `attempted_timestamp` for drift auditing — never as the stored punch time.
4. **One open session per user**, enforced by the partial unique index on `TIM_WorkSession (user_id) WHERE clock_out_time IS NULL` — not by application checks alone.
5. **Geolocation never blocks a punch.** Missing/denied GPS records `geo_status` and proceeds. Geofence is an audit signal, not a gate.
6. **MFA (aal2) gates manager/admin WRITES only.** Reads are role-scoped but not aal2-gated. Employee writes are never aal2-gated.
7. **Error envelope is uniform:** `{ error: { code, message, http_status } }`. One `callRpc()` helper in `/lib` owns the mapping; call sites never re-implement it. `message` must be toast-safe (no stack traces, SQL, or internal IDs).
8. **Rate limits are checked first** in every guarded RPC via `RTL_RateLimitEvent` sliding-window counts. Breaches log `RATE_LIMIT_TRIGGERED`.
9. **Audit everything enumerated.** `AUD_SystemLog.action_type` is a closed CHECK list; adding an action type = migration + SPEC.md update in the same PR.
10. **Immutable notifications.** `NTF_Notification.title/body` are interpolated server-side at insert; clients only read and mark-read.
11. **Idempotency-on-retry rule:** ONLY the offline sync worker treats `USER_ALREADY_CLOCKED_IN` (on clock-in retry) and `NO_ACTIVE_SESSION` (on clock-out retry) as success-and-dequeue. Live UI calls surface them as real errors.
12. **No new hardcoded limits** except the deliberate ones: 50-user trigger cap, 4h break auto-close, 16h long-session flag. These change only by migration + spec change.

## Conventions

- **SQL:** tables `MST_/TIM_/AUD_/RTL_/NTF_` prefixes as in SPEC. Columns snake_case. Every domain table: `id UUID PK default gen_random_uuid()`, `organization_id` FK, `created_at TIMESTAMPTZ default NOW()`. All timestamps TIMESTAMPTZ in UTC. Enum-like fields use CHECK constraints, not Postgres enums.
- **RPC exceptions:** `RAISE EXCEPTION 'CODE'` with codes from SPEC.md §5; add new codes to §5's table in the same PR.
- **TypeScript:** strict mode; generated DB types via `supabase gen types typescript` committed to `/lib/database.types.ts`; no `any` in new code.
- **UI:** Apple-inspired design language per SPEC.md §9 — system font stack, tokens.css custom properties, 8-pt grid, one coral (`--tint`) filled element per view, semantic red (never coral) for destructive actions, `prefers-reduced-motion` respected in every animation, 44px minimum hit targets, `tabular-nums` on all timers/durations.
- **Naming in UI copy:** the product is written "zedHR" (never ZEDHR/Zedhr). The wordmark artwork is fixed — never re-typeset it.
- **Dates in UI:** format per `MST_Organization.display_locale`; org timezone (default Asia/Manila) for exports.

## Commands

```bash
pnpm dev                 # Next.js dev server
supabase start           # local stack (Docker)
supabase db reset        # rebuild local DB from migrations + seed
supabase db push         # apply migrations to linked project (deliberate, manual)
supabase gen types typescript --local > lib/database.types.ts
pnpm test                # Vitest (unit + RLS tests against local supabase)
pnpm test:e2e            # Playwright
pnpm lint && pnpm typecheck
```

## Definition of done (every task)

- Migration applied cleanly on `supabase db reset` from scratch.
- RLS test proves the negative case (wrong user/role/org CANNOT read or write).
- RPC has: rate-limit-first check (if guarded), enumerated exceptions, audit log insert where SPEC requires.
- UI states covered: loading (skeleton >300ms), empty state, error toast, success.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.
- SPEC.md milestone checklist item ticked in the same PR.

## Secrets & safety

- `SUPABASE_SERVICE_ROLE_KEY` exists only in Vercel server-side env and Edge Function secrets — never in client bundles, never in the repo.
- Backup dumps contain PII: the GitHub Actions workflow must gpg-encrypt before uploading the artifact; passphrase lives outside GitHub.
- Never log tokens, password hashes, backup codes, or raw JWTs.
- Seed scripts (first admin) are run manually by the developer — never wire them into deploy.
