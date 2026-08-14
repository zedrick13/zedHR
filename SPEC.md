# SPEC.md — zedHR Timekeeping Module

Implementation specification for Claude Code. Derived from **ZedHR SRS v7** (August 2026), the Phase 1 project documents (Project Brief, Requirements Traceability Matrix, Supporting Documents), and the zedHR Brand Identity Guidelines v1.1. Section references like (SRS §4.1) point at the SRS for full detail; this file is self-sufficient for implementation but the SRS is the tiebreaker.

Work through the milestones in §10 in order. Tick checkboxes as tasks complete. Do not start a milestone before the previous one's acceptance criteria pass.

---

## 1. Product summary

A responsive web application for **one organization (~50 employees)** to:

- Clock in / clock out with optional geolocation capture and geofence auditing
- Track paid short breaks (**CB**, compensable) and unpaid lunch breaks (**LB**, non-compensable)
- Submit and review **timesheet correction requests** (manager/admin approval workflow)
- Give managers a live dashboard (headcount, direct reports, corrections queue, reports/CSV export)
- Operate offline (punch queue + sync with conflict detection)
- Meet PH **RA 10173** obligations (retention, anonymization, DSAR support)

**Out of scope (hard boundary):** any pay computation (overtime pay, night differential, holiday premiums), payroll, leave management, ESS beyond this module, native mobile apps, self-service org signup. `MST_Holiday` is stored for the future Payroll module but is read by nothing in this module.

**Roles:** `employee`, `manager`, `admin`. Managers act only on departments where they are `MST_Department.manager_id`. Admins act org-wide. MFA (TOTP, aal2) is mandatory for manager/admin writes.

---

## 2. Architecture

### 2.1 Platforms (exactly three)

- **GitHub** — source control; one scheduled Actions workflow (weekly encrypted pg_dump backup). No deploy workflows: Vercel's Git integration deploys on push to `main`, previews on PRs.
- **Vercel** — Next.js App Router (TypeScript). SSR/route handlers pinned to `sin1`. Automatic SSL/CDN. Domains `zedhr.com` / `www.zedhr.com` via Namecheap DNS records (registrar only).
- **Supabase (Singapore)** — Postgres + RLS, Auth (email/password + TOTP MFA), Storage (`avatars` public bucket, `backups` private bucket), Edge Functions, Realtime, pg_cron.

### 2.2 Request paths

- **Reads:** PostgREST selects under RLS, or read-only RPCs (`get_active_session_state`).
- **Writes:** Postgres RPCs only (SRS §4). One shared `callRpc()` helper maps `RAISE EXCEPTION 'CODE'` to the error envelope `{ error: { code, message, http_status } }` (SRS §12.3).
- **Privileged operations** (Supabase Admin API — create auth user, force sign-out): thin Next.js Route Handlers holding the service-role key server-side; they delegate to the same RPC contracts and add no independent API.
- **Middleware (Vercel edge):** session cookie → JWT verify → `aal` check for `/dashboard` & `/admin` routes → redirect to `/login` or `/mfa`. UX only; RLS is the real boundary (SRS §2.4, §9).

### 2.3 API conventions (SRS §12)

- Single unversioned contract; breaking RPC changes are coordinated deploys.
- Cross-cutting error codes: `ERR_RATE_LIMITED` (429), `UNAUTHORIZED` (403), `MFA_REQUIRED` (403), `ERR_USER_LIMIT_EXCEEDED` (403), `ERR_VALIDATION` (422).
- No RPC is idempotent. Offline sync worker only: treat `USER_ALREADY_CLOCKED_IN` (clock-in retry) / `NO_ACTIVE_SESSION` (clock-out retry) as success-and-dequeue (SRS §12.4).

### 2.4 Forward-compatibility rules (Phase 1 multi-tenant readiness)

The Phase 1 zedHR is a multi-tenant SaaS (tenant-per-subdomain, e.g. `acme.zedhr.com`) spanning Timekeeping, Payroll, ESS, and Leave. This build is single-org but must not require a rewrite to get there:

1. **`organization_id` on every domain table** (already in schema) and in every RLS policy predicate — never "the only org" implied by omission.
2. **One org-resolution helper** — `lib/org.ts` exposes `getCurrentOrgId()`. Today it returns the user's `MST_User.organization_id`; in Phase 1 it will resolve from subdomain. No other code derives the org.
3. **RLS policies call SQL helper functions** (`app_current_user_id()`, `app_user_role()`, `app_user_org_id()`) reading JWT claims — so tenant-scoping changes happen in one place per concern.
4. **Module folder discipline:** timekeeping code under `components/features/timekeeping/`, `app/(app)/timesheet/` etc., so payroll/leave arrive as siblings, not surgery.
5. **Naming continuity:** where this module and the Phase 1 data dictionary describe the same concept, keep semantics compatible (statuses `pending/approved/rejected`; corrections never delete originals; append-only audit).
6. **Deliberate single-org constants** (50-user trigger cap, seed-script provisioning, no signup flow) are isolated and documented so Phase 1 replaces them consciously.

---

## 3. Database schema (SRS §3)

All timestamps `TIMESTAMPTZ` (UTC). All PKs `UUID DEFAULT gen_random_uuid()`. Enum-like fields via CHECK constraints. RLS enabled on every table in its creating migration.

**M1 implementation note:** every table below carries `organization_id` even where its bullet doesn't restate it (CLAUDE.md forward-compat rule #1 is unconditional: "organization_id on every domain table"). This affects `TIM_CompensableBreak`/`TIM_NonCompensableBreak`, `TIM_SyncConflict`, `MST_Holiday`, `AUD_SystemLog`, `MST_MfaBackupCode`, `RTL_RateLimitEvent` (nullable — some rate-limit buckets are pre-auth, e.g. `login:{email}`), and `NTF_Notification`. `MST_User` also carries `role_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, required by §7 "Sessions" (role changes force re-login) but omitted from the abbreviated bullet below.

### 3.1 Tables

**MST_Organization** — org config: `name`, `timezone` (default `Asia/Manila`), `display_locale`, `pay_cycle_type` CHECK (`weekly|biweekly|monthly`), `pay_cycle_start_date`, geofence `latitude/longitude/radius_m`, `max_cb_minutes` (default 20), `min_lb_minutes`, `data_retention_days` (default 365).

**MST_Department** — `organization_id` FK NOT NULL, `name`, `manager_id` FK → MST_User NULLABLE. One manager per department; one manager may run many departments; unmanaged departments route approvals to any admin.

**MST_User** — extends `auth.users` (PK = auth.users.id FK): `organization_id`, `department_id` NULLABLE, `first_name`, `last_name`, `role` CHECK (`employee|manager|admin`), `is_active`, `mfa_enrolled` BOOL, `avatar_path` NULLABLE, `terminated_at` NULLABLE, `scheduled_purge_at` NULLABLE.

**MST_UserInvitation** — `organization_id`, `email`, `role` CHECK, `token` (crypto-random), `expires_at` default `created_at + interval '7 days'`, `is_used`, `revoked_at/revoked_by`, `invited_by`. UNIQUE (`organization_id`,`email`).

**TIM_WorkArrangement** — polymorphic: `target_level` CHECK (`organization|department|user|day`), `target_id` UUID, `arrangement` CHECK (`office|wfh|hybrid`), `effective_date`, `expires_date` NULLABLE.

**TIM_WorkSession** — `user_id`, `organization_id`, `clock_in_time`, `clock_out_time` NULLABLE, `clock_in_ip/clock_out_ip`, `clock_in_geo_status`/`clock_out_geo_status` CHECK (`checked|unavailable|denied`), `clock_in_lat/lng`, `clock_out_lat/lng` NULLABLE, `clock_in_outside_boundary`/`clock_out_outside_boundary` BOOL default false, `flagged_long_running` BOOL default false.
**Partial unique index:** `CREATE UNIQUE INDEX idx_open_work_session ON TIM_WorkSession (user_id) WHERE (clock_out_time IS NULL);`

**TIM_CompensableBreak / TIM_NonCompensableBreak** — `work_session_id` FK, `start_time`, `end_time` NULLABLE, `is_auto_closed` BOOL, `policy_violation` BOOL, `policy_violation_reason` CHECK. Violations are evaluated **on close only**: CB_OVERTIME if duration > `max_cb_minutes`; LB_SHORT if duration < `min_lb_minutes`. M1 implementation: each table's CHECK is tightened to the single reason it can actually produce (`CB_OVERTIME` only on the CB table, `LB_SHORT` only on the LB table) rather than the combined `CB_OVERTIME|LB_SHORT` list, and each has a partial unique index (`work_session_id) WHERE end_time IS NULL`) mirroring `idx_open_work_session`'s one-open-row-at-a-time guarantee (CLAUDE.md invariant #4's rationale extended to breaks).

**TIM_CorrectionRequest** — `user_id`, `organization_id`, `work_session_id` NULLABLE, `request_type` CHECK (`clock_in|clock_out|cb_start|cb_end|lb_start|lb_end|create_session`), `requested_timestamp`, `reason` TEXT NOT NULL (1–500 chars, enforced at RPC), `status` CHECK (`pending|approved|rejected`), `reviewed_by/reviewed_at`, `rejection_note` NULLABLE (≤500).

**TIM_SyncConflict** — `user_id`, `work_session_id` NULLABLE, `failed_action`, `details` JSONB, `created_at`.

**MST_Holiday** — reference-only for future Payroll (`date`, `name`, `type` CHECK (`regular|special_non_working|custom`), `region_scope`). No reads in this module.

**AUD_SystemLog** — append-only: `actor_id` NULLABLE, `target_id` NULLABLE, `action_type` CHECK (closed list, see registry below), `previous_value` JSONB, `new_value` JSONB, `created_at`. No UPDATE/DELETE policies for anyone; writes go exclusively through `private.log_audit_event()` (SECURITY DEFINER).

**`action_type` registry (M1, flagged assumption):** this file only had the shorthand "CLOCK_IN … DSAR_REQUEST_FULFILLED" pointing at SRS §3.1 for the full closed list. The SRS wasn't available while implementing M1, so the list below was derived from every RPC/job/feature named in this document instead, and is the local source of truth until confirmed against the actual SRS §3.1 (see §11 open items):

`CLOCK_IN` · `CLOCK_OUT` · `CB_STARTED` · `CB_ENDED` · `LB_STARTED` · `LB_ENDED` · `CORRECTION_SUBMITTED` · `CORRECTION_APPROVED` · `CORRECTION_REJECTED` · `TIMECARD_ADMIN_EDITED` · `INVITATION_CREATED` · `INVITATION_REVOKED` · `INVITATION_ACCEPTED` · `USER_TERMINATED` · `USER_ANONYMIZED` · `MFA_ENROLLED` · `MFA_RESET` · `USER_ROLE_CHANGED` · `DSAR_REQUEST_LOGGED` · `DSAR_REQUEST_FULFILLED` · `LOGIN_FAILED` · `LOGIN_LOCKOUT` · `RATE_LIMIT_TRIGGERED`.

Adding a type beyond this list = migration + update this registry in the same PR (CLAUDE.md invariant #9).

**MST_MfaBackupCode** — `user_id`, `code_hash` (bcrypt; plaintext shown once), `is_used`, `used_at`.

**RTL_RateLimitEvent** — `user_id` NULLABLE, `bucket_key` VARCHAR, `created_at`. Sliding-window counter for §6 limits; purged >24h old.

**NTF_Notification** — `recipient_id`, `template` CHECK (`B|C|D|E|G`), `title`, `body` (server-interpolated, immutable), `link_path` NULLABLE, `dedupe_key` NULLABLE, `is_read` default false, `read_at`. Realtime-enabled. Recipients SELECT + UPDATE(is_read, read_at) own rows only; inserts server-side only. Purged >180 days.

### 3.2 RLS matrix (SRS §9, §14.6)

| Table | employee | manager | admin |
|---|---|---|---|
| TIM_WorkSession, breaks | R/W own rows | + R for managed depts; no direct writes (RPC-mediated corrections only) | + R all; edits via `admin_edit_locked_timecard` (aal2) |
| TIM_CorrectionRequest | create + R own | + R managed depts; approve/reject via RPC (aal2) | + all depts (aal2 writes) |
| MST_User | R own profile | R own + managed dept members (limited columns) | R/W all (aal2 writes) |
| MST_Department, TIM_WorkArrangement, MST_Holiday, MST_Organization | R | R | W (aal2) |
| NTF_Notification | R + mark-read own | same | same |
| AUD_SystemLog | — | — | R only |
| RTL_RateLimitEvent, MST_MfaBackupCode | no client access (RPC/security-definer only) | | |

**MFA gate:** manager/admin write policies additionally require `auth.jwt() ->> 'aal' = 'aal2'`. Reads are never aal2-gated. Employee writes are never aal2-gated.

**M1 implementation notes on this matrix:**

- **RLS write model.** The "W"/"R/W own rows"/"create" cells above describe the *net effect* of RLS + RPCs together, not a literal RLS INSERT/UPDATE/DELETE grant. CLAUDE.md invariant #2 ("all writes go through Postgres RPCs, no direct `.insert()/.update()/.delete()` from the client") is applied literally: every table's RLS policies added in M1 are SELECT-only, with exactly one exception the matrix already calls out explicitly — `NTF_Notification`'s recipient-side `is_read`/`read_at` mark-read, implemented as a column-level `GRANT UPDATE (is_read, read_at)` (not a full-row grant) combined with a row policy. All other writes ("W") happen through SECURITY DEFINER RPCs added in M2–M7, which bypass RLS as the table owner. Granting direct client writes on e.g. `TIM_WorkSession` or `TIM_CorrectionRequest` would let a client bypass the RPC's own rate-limiting, validation, and server-authoritative-timestamp logic — exactly what invariant #2 exists to prevent.
- **MST_User "limited columns" for managers** (row 3) is deferred: Postgres RLS filters rows, not columns, and column-level `GRANT` can't differentiate employee/manager/admin because they share one Postgres role (`authenticated`) — differentiation happens entirely through JWT claims read inside policies. M1 gives managers full-row read of their managed department's members; a dedicated column-limited view is planned for the M5 Direct Reports grid once its actual column needs are known.
- **JWT claim naming.** The custom access token hook stamps `organization_id`, `user_role`, and `role_changed_at` onto the JWT — note `user_role`, not `role`. Supabase's JWT already has a top-level `role` claim PostgREST uses to select the Postgres connection role (`anon`/`authenticated`); overwriting it with the employee/manager/admin value would break authentication entirely. This file's "custom claims (role, organization_id, ...)" wording in §2.4/§10 refers to the data being carried, not this literal JSON key.
- **Helper function location.** `app_current_user_id()`, `app_user_role()`, `app_user_org_id()`, and related predicates live in a `private` schema (not `public`), per `supabase/config.toml`'s `[api] schemas` (only `public`/`graphql_public` are PostgREST-exposed). This keeps them usable inside RLS policies (a normal `EXECUTE` grant, unrelated to PostgREST routing) without being directly callable as a client RPC — revoking `EXECUTE` from `authenticated` instead would have broken every policy that calls them.

---

## 4. RPC contracts (SRS §4)

All are `SECURITY DEFINER` SQL/plpgsql functions with `search_path` pinned; each performs its own authorization + rate-limit checks and audit inserts. Full step-by-step logic is in the SRS; the contract summary:

| RPC | Auth | Rate bucket | Throws |
|---|---|---|---|
| `clock_in_user(lat,lng)` | any authed | `clock_action:{uid}` 10/60s (shared) | ERR_RATE_LIMITED, USER_ALREADY_CLOCKED_IN |
| `clock_out_user(lat,lng)` | any authed (own open session) | shared bucket | ERR_RATE_LIMITED, NO_ACTIVE_SESSION |
| `start_cb()/end_cb()/start_lb()/end_lb()` | any authed (own open session) | shared bucket | NO_ACTIVE_SESSION, BREAK_ALREADY_OPEN, NO_ACTIVE_BREAK |
| `get_active_session_state()` | any authed | none (read-only) | — |
| `submit_correction_request(...)` | any authed (own records) | `correction_submit:{uid}` 20/24h | ERR_VALIDATION (reason 1–500), ERR_RATE_LIMITED |
| `approve_correction_request(id)` | manager (own depts) / admin; **aal2** | — | CORRECTION_NOT_FOUND, CORRECTION_ALREADY_RESOLVED, UNAUTHORIZED |
| `reject_correction_request(id, note)` | same | — | same |
| `admin_edit_locked_timecard(session, in, out, reason)` | admin; **aal2** | — | UNAUTHORIZED, EDIT_REASON_REQUIRED, SESSION_NOT_FOUND, INVALID_TIME_RANGE |
| `accept_invitation(token, password, first, last)` | **authenticated** (M2 deviation, see note below) | `invitation_accept:{token}` 10/10min | INVITATION_NOT_FOUND / ALREADY_USED / REVOKED / EXPIRED, PASSWORD_POLICY_VIOLATION, ERR_RATE_LIMITED |
| `terminate_user(user_id)` | admin; aal2 | — | UNAUTHORIZED, USER_NOT_FOUND |
| `force_anonymize_user(user_id)` | admin; aal2 | — | UNAUTHORIZED, USER_NOT_TERMINATED |
| `admin_reset_mfa(user_id)` | admin; aal2 | — | UNAUTHORIZED |
| `change_user_role(user_id, role)` | admin; aal2 | — | UNAUTHORIZED; forces target re-login (SRS §14.6) |
| `log_dsar_request(user_id, type, notes)` / `resolve_dsar_request(id)` | admin; aal2 | — | UNAUTHORIZED |

Key behaviors baked into `clock_in_user`/`clock_out_user`: rate-limit first → concurrency check → `inet_client_addr()` capture → geo path 4a (null coords ⇒ `denied`/`unavailable`, boundary false, never blocked) or 4b (`checked`) → work-arrangement cascade (day → user → department → org; hybrid defaults to office absent a day override) → Haversine geofence flag when office/defaulted-hybrid → insert/update + audit log. Clock-out also force-closes any open break (`is_auto_closed = true`, evaluate violation).

**Approve `create_session` note:** a fully missing shift = two linked requests (create_session for clock-in, then clock_out against the new session). Never widen the schema for this.

**Notifications emitted by RPCs/jobs:** submit_correction → Template B to manager (or any admin if unmanaged dept); approve/reject → Template D to employee; geofence breach → Template C (dedupe `geofence:{manager_id}:{employee_id}`, 12h); long-running job → Template E (dedupe `longrun:{session_id}`, 24h); log_dsar_request → Template G.

**M2 note — `accept_invitation` auth mode.** CLAUDE.md restricts Auth email (invites, password reset) to Supabase Auth's built-in mailer, and the only mailer-trigger available for inviting a brand-new user is `auth.admin.inviteUserByEmail`. That call creates the `auth.users` row and authenticates the browser the instant the emailed link is clicked — there's no way to keep the flow genuinely pre-auth while still using Supabase's own mailer for a new-user invite. So `accept_invitation` runs **authenticated** (the session from the clicked link), setting the real password directly via `pgcrypto` (`crypt(password, gen_salt('bf'))` — standard bcrypt, format-compatible with GoTrue's own password checks) rather than going through `auth.admin.createUser`. The admin-side invite creation (`create_invitation` RPC + a `/api/admin/invitations` Route Handler that calls `inviteUserByEmail`) is unaffected and still matches §2.2's Route-Handler-holds-the-service-role-key model.

**M2 note — backup-code aal2.** Supabase Auth's native MFA API has no backup/recovery-code factor type, so `verify_backup_code` can't go through `auth.mfa.verify()` to earn aal2 the normal way. Instead it sets `MST_User.pending_aal2_grant_at = now()` on a successful match; `custom_access_token_hook` stamps `aal: 'aal2'` onto the *next* minted token if that marker is set and less than 2 minutes old, then clears it (single-use). The client must call `supabase.auth.refreshSession()` immediately after a successful `verify_backup_code` call so the hook re-runs and the new token carries aal2.

### Edge Function

`get_avatar_upload_url(file_name, file_size, content_type)` — verify auth + active user; validate ≤ 2 MB and `image/png|image/jpeg`; rate bucket `avatar_upload:{uid}` 5/hour; return Supabase Storage signed upload URL for `organizations/{org}/users/{uid}/avatars/{file}`. Storage RLS confines writes to the caller's own prefix.

---

## 5. Error codes registry

`ERR_RATE_LIMITED` 429 · `UNAUTHORIZED` 403 · `MFA_REQUIRED` 403 · `ERR_USER_LIMIT_EXCEEDED` 403 · `ERR_VALIDATION` 422 · `USER_ALREADY_CLOCKED_IN` 409 · `NO_ACTIVE_SESSION` 404 · `BREAK_ALREADY_OPEN` 409 · `NO_ACTIVE_BREAK` 404 · `CORRECTION_NOT_FOUND` 404 · `CORRECTION_ALREADY_RESOLVED` 409 · `EDIT_REASON_REQUIRED` 422 · `SESSION_NOT_FOUND` 404 · `INVALID_TIME_RANGE` 422 · `INVITATION_NOT_FOUND` 404 · `INVITATION_ALREADY_USED` 409 · `INVITATION_REVOKED` 410 · `INVITATION_EXPIRED` 410 · `PASSWORD_POLICY_VIOLATION` 422 · `USER_NOT_FOUND` 404 · `USER_NOT_TERMINATED` 409 · `INVALID_MFA_CODE` 422 (added in M2: backup-code verification, SPEC §7, wasn't in the original registry).

Adding a code = update this table + SRS traceability in the same PR.

---

## 6. Rate limits (SRS §13.2)

| Action | Bucket | Limit / Window |
|---|---|---|
| Failed login | `login:{email}` | 5 / 15 min → LOGIN_LOCKOUT (15 min from 5th failure, email-keyed not IP-keyed) |
| clock in/out + break RPCs | `clock_action:{user_id}` | 10 combined / 60 s |
| Avatar upload URL | `avatar_upload:{user_id}` | 5 / 60 min |
| Correction submission | `correction_submit:{user_id}` | 20 / 24 h |
| accept_invitation | `invitation_accept:{token}` | 10 / 10 min |
| CSV export | `report_export:{user_id}` | 30 / 60 min |
| Password reset | `password_reset_request:{email}` | 3 / 60 min |

Reads are never rate-limited. Every breach → `AUD_SystemLog RATE_LIMIT_TRIGGERED`.

---

## 7. Authentication & security policy (SRS §14)

- **Provider:** Supabase Auth email+password only. No OAuth, no magic links.
- **Password:** ≥10 chars, ≥1 letter, ≥1 number; enforced client-side, in `accept_invitation`, and in Supabase Auth settings. No rotation, no history check (deliberate).
- **Lockout:** per table above; reset path stays available during lockout; generic "if that email exists…" response on `/forgot-password`.
- **MFA:** TOTP required for manager/admin. Enrollment on first login (`/mfa/enroll` reachable pre-aal2); 8 single-use backup codes (bcrypt hashes only; must-acknowledge checkbox); backup-code use grants aal2 then **forces re-enrollment**; `admin_reset_mfa` for exhausted codes; sole-admin lockout = documented manual DB fix by operator.
- **Sessions:** 1h JWT silently refreshed; refresh revoked on logout, password reset, MFA reset. Role changes force re-login (`role_changed_at` marker checked by RLS for privileged ops).
- **Provisioning:** no public signup. First admin via developer-run seed script (temp password out-of-band; must change password + enroll MFA on first login — no bypass). Everyone else via invitation (Template A email through Supabase Auth mailer). 50-user cap enforced by insert trigger → `ERR_USER_LIMIT_EXCEEDED`; UI `/limit-exceeded` screen.

---

## 8. Offline queue, jobs, compliance

### 8.1 Offline (SRS §6)

localStorage `punch_queue` items `{ id, action, payload: { attempted_timestamp, lat, lng } }`. On `online` event: sequential dequeue, exponential backoff 2s→32s (5 attempts), then `TIM_SyncConflict` + continue queue. Drift strictly > 5:00 vs server NOW() (discounting offline period) ⇒ `is_suspicious_drift` log. Overlap with an existing session ⇒ conflict + notify manager. Idempotent-error rule per §2.3.

### 8.2 Scheduled jobs (pg_cron, SRS §15)

- `auto_close_abandoned_breaks_and_sessions()` — every 15 min. Breaks open >4h: close at start+4h, `is_auto_closed`, evaluate violation (abandoned LB never gets LB_SHORT). Sessions open >16h & unflagged: flag + Template E; **never** fabricate a clock-out.
- `purge_stale_rows()` — every 6 h: RTL rows >24h; NTF rows >180d.
- `run_scheduled_anonymization()` — daily 02:00 Asia/Manila: executes §8.3 for `scheduled_purge_at <= NOW()`.

### 8.3 RA 10173 (SRS §10)

Termination sets `terminated_at` + `scheduled_purge_at = terminated_at + data_retention_days`. Anonymization sequence (order is load-bearing): (1) scrub MST_User fields (`anonymized-{id}@zedhr.com`, names, inactive); (2) scrub free-text/PII in corrections, sync conflicts, audit JSON, and NTF rows; commit; (3) separate transaction deletes `auth.users`; (4) log `USER_ANONYMIZED`. DSAR intake/fulfillment via `log_dsar_request`/`resolve_dsar_request` + CSV export scoped to the requester; 30-day SLA; erasure for active employees is declined per legal-retention exemption, for terminated employees triggers `force_anonymize_user`.

---

## 9. UI specification (SRS §17 + Brand Guidelines v1.1)

**Design language:** Apple-inspired — clarity, deference, depth — implemented with web standards. No Apple proprietary assets (no SF fonts bundled, no SF Symbols); system font stack + Lucide icons (1.5–1.75px stroke).

**Tokens (`styles/tokens.css`, light/dark via `prefers-color-scheme` + in-app override):**
`--tint` #FF6B6B (Coral Catalyst — the ONLY accent; one filled-tint element per view) · `--label-primary` #2C3E50 / dark #F5F7FA · `--label-secondary` #7F8C8D / #9AA5AE · `--bg-base` #ECF0F1 / #15191E · `--bg-elevated` #FFFFFF / #1E242B · `--separator` rgba(44,62,80,.12) / rgba(255,255,255,.10) · `--semantic-red` #E5484D / #FF6369 (destructive — coral is NEVER a warning) · `--semantic-green` #2F9E63 / #3DD68C · `--semantic-amber` #B78103 / #F5B93B.

**Type scale:** Large Title 34/700 · Title1 28/700 · Title2 22/700 · Headline 17/600 · Body 17/400 · Callout 16 · Subheadline 15 · Footnote 13 · Caption 12. Rem-based; `tabular-nums` on all timers/durations.

**Surfaces & layout:** translucent bars (`backdrop-filter: blur(20px) saturate(180%)` over 72–80% `--bg-elevated`, solid fallback); grouped cards radius 12 (sheets/popovers 16, small controls 8); hairline inset separators; shadows only `0 1px 3px rgba(16,24,40,.07)` resting / `0 12px 32px rgba(16,24,40,.16)` floating; 8-pt grid; 16/24px insets mobile/desktop.

**Navigation:** desktop translucent sidebar with z brand mark; mobile bottom tab bar ≤4 tabs (employee: Home, Timesheet, Requests, Profile; manager: Approvals replaces Requests; admin adds Admin section in sidebar).

**Controls:** filled-tint primary button, gray-fill secondary, iOS-style switches, segmented controls for report ranges, filled input fields with 2px tint focus ring, 44px min hit targets. Modality via sheets (bottom sheet + grab handle mobile; centered card + dim + background scale desktop). Destructive confirms: title, one line, red action, Cancel default.

**Motion:** standard curve `cubic-bezier(0.32, 0.72, 0, 1)`; sheets ~350ms slide, popovers ~200ms scale 0.96→1; press scale 0.97; only `transform`/`opacity` animate; timer digits are the only interval animation; full `prefers-reduced-motion` support.

**Feedback:** input acknowledged ≤100ms (optimistic pressed/loading states); skeletons for loads >300ms; toasts = top-center capsules, 4s, max 2 stacked; empty states = icon + title + one line + optional action.

**Screens (route map):**

| Route | Contents |
|---|---|
| `/login`, `/forgot-password`, `/invite/{token}`, `/mfa`, `/mfa/enroll`, `/limit-exceeded` | Auth surface per §7 |
| `/` (Home) | Greeting large-title; Clock In/Out control (state machine CLOCKED_OUT / CLOCKED_IN_IDLE / ON_CB / ON_LB via `get_active_session_state`, SRS §5.1); live shift/break timers; CB/LB buttons; geolocation banner rules (SRS §5.2); GPS consent sheet on first run |
| `/timesheet` | Own sessions/breaks by pay-cycle range; violation & geo chips; "Request correction" per row + missing-shift flow |
| `/requests` | Own correction requests + statuses |
| `/dashboard` (manager/admin) | Headcount widget; Direct Reports grid (Name, Department, Status, Today's Hours, Geofence: Ok / Out of Bounds / N/A (WFH) / N/A (No GPS)); Corrections queue (approve/reject with staleness-guard error handling); Reports pane with dept/employee filters + CSV export (org-timezone timestamps) |
| Notification center | Bell + unread badge (Realtime), popover inbox, mark-read + deep-link |
| `/admin/*` | Users (invite/revoke/terminate/role-change), departments, work arrangements, holidays, org settings, audit log viewer, DSAR log/resolve |
| `/profile` | Own info, avatar upload (Edge Function flow), password change |

---

## 10. Milestone plan & task checklists

Conventions: every task obeys CLAUDE.md's Definition of Done. Each milestone ends with acceptance criteria (AC) that must pass before the next begins. TC-xx references are analogous cases in the Phase 1 Test Case Library where they exist.

### M0 — Repo, tooling, environments

- [x] Init Next.js (App Router, TS strict) + pnpm; ESLint + Prettier; folder layout per CLAUDE.md
- [x] `supabase init`; local stack boots; link project; envs wired in Vercel (`sin1` pinned) with anon/service keys split client/server
- [x] `styles/tokens.css` with §9 tokens (light+dark); base layout renders with system font stack
- [x] `lib/callRpc.ts` (envelope mapping, typed codes from §5); `lib/org.ts` (`getCurrentOrgId()`)
- [x] Vitest + Playwright scaffolds; CI = Vercel builds only (no GH deploy workflow)
- [x] Seed script `scripts/seed-first-admin.ts` (org row + first admin, temp password) — manual-run only

**AC:** `pnpm dev` serves a tokened shell; `supabase db reset` clean; a trivial RPC round-trips through `callRpc` locally.

### M1 — Schema & RLS foundation

- [x] Migrations for all §3 tables incl. CHECKs, FKs, partial unique index `idx_open_work_session`, 50-user insert trigger
- [x] JWT helper functions (`app_user_role()`, `app_user_org_id()`, `app_current_user_id()`); custom claims (`user_role`, `organization_id`, `role_changed_at` guard) via auth hook — see §3.2 M1 note on the `user_role` claim naming
- [x] RLS policies per §3.2 matrix, aal2 predicates on manager/admin writes
- [x] `AUD_SystemLog` append-only (no update/delete policies); insert helper function
- [x] `RTL_RateLimitEvent` + `check_rate_limit(bucket, max, window)` SQL helper
- [x] Generated types committed; RLS test suite: for each table, prove cross-user/cross-role/negative cases (analog TC-020/TC-023: wrong-user reads return nothing, not errors that reveal existence)

**AC:** RLS suite green; direct PostgREST write attempts as employee against protected tables fail; reset-from-scratch clean.

### M2 — Auth, invitations, MFA

- [x] `/login` with lockout UX (5/15min, email-keyed) + LOGIN_FAILED/LOCKOUT audit
- [x] `/forgot-password` (generic response, Supabase reset mail, 3/60min bucket) + revoke-all-sessions on completion
- [x] `accept_invitation` RPC + `/invite/{token}` page (password policy w/ inline rule feedback; auto sign-in; cap redirect to `/limit-exceeded`)
- [x] Admin invite flow (create invitation + Template A mail via Auth admin route handler; revoke) — minimal `/admin` page (invite form + pending-invitations list); the full M7 admin section (departments, work arrangements, holidays, org settings, audit log viewer) is still to come
- [x] MFA enroll (`/mfa/enroll`: TOTP QR, verify, 8 backup codes shown once + acknowledge checkbox, `mfa_enrolled`, MFA_ENROLLED log) and challenge (`/mfa`: TOTP or backup code → aal2 → forced re-enroll after backup use)
- [x] `admin_reset_mfa`, `change_user_role` (force sign-out + `role_changed_at`), `terminate_user`
- [x] Middleware (now `proxy.ts` — Next.js 16 renamed the convention): session → `/login`; manager/admin without `mfa_enrolled` → `/mfa/enroll`; without aal2 → `/mfa`
- [x] E2E: invite→accept→login (`tests/rls/auth.test.ts`, live-Supabase RPC suite) + a full browser walkthrough (`tests/e2e/auth-flow.spec.ts`: login → forced MFA enrollment → home) proving employee/manager gating end-to-end

**AC:** a pre-aal2 manager/admin is redirected to `/mfa` by the proxy before reaching any protected page (stricter than "can read dashboards" — there's no dashboard yet to test against, M5) — but the AC's real intent, that reads work and writes don't regardless of what the proxy does, is what's actually verified: `require_admin_write()`/`require_manager_or_admin_write()` raise `MFA_REQUIRED` at the RPC layer independent of the proxy, and `tests/rls/auth.test.ts` calls these RPCs directly (bypassing the browser/proxy entirely) to prove it.

**M2 implementation notes:**

- **`accept_invitation` auth mode and backup-code aal2** — see the notes already added under §4 above.
- **Hard navigation after auth-state changes.** Every page that changes session-relevant state right before redirecting (login success, MFA enroll/challenge, password reset, invitation accept) uses `window.location.href`, not `router.push()`. A client-side Next.js transition can be served from a prefetch cache that predates the state change, so the proxy never re-runs against the new session/DB state — this was caught by `tests/e2e/auth-flow.spec.ts` failing (landed back on `/mfa/enroll` after completing enrollment) before the fix.
- **React Strict Mode double-invoke.** `/mfa/enroll`'s enrollment `useEffect` guards against dev-mode double-invocation with a ref; without it, two TOTP factors get created and the displayed QR/secret can end up inconsistent with the factor actually challenged. Also caught by the same e2e test.
- **`AUD_SystemLog.organization_id` is now nullable.** `LOGIN_FAILED`/`LOGIN_LOCKOUT` happen pre-auth against a bare email with no resolvable org (M1's schema had this `NOT NULL`); the admin-read RLS policy was updated to also allow `organization_id IS NULL` rows.

### M3 — Core timekeeping loop

- [x] RPCs: `clock_in_user`, `clock_out_user` (full SRS §4.1/§4.2 sequence), `start_cb/end_cb/start_lb/end_lb` (violation-on-close), `get_active_session_state`
- [x] Home screen state machine + live timers (tabular-nums, no layout shift); optimistic pressed states ≤100ms
- [x] Geolocation handling (5s timeout; denied banner once/session; unavailable silent) + GPS consent sheet (NPC compliance)
- [x] Work-arrangement cascade + Haversine geofence in-database; boundary flags recorded
- [x] `/timesheet` self-view with pay-cycle ranging and status/geo chips
- [x] Unit tests: duplicate clock-in 422/409 path (TC-002 analog), one-open-session index race (two concurrent clock-ins ⇒ exactly one row), violation math boundaries, hybrid-defaults-to-office rule

**AC:** TC-001/TC-002 analogs green; punch p95 <500ms against Singapore project from PH network (spot-check) — not measurable in this sandbox (no deployed Singapore project to test against; local-stack latency was consistently well under 500ms, but that isn't the AC's actual claim); a punch with no GPS records `geo_status` and succeeds.

**M3 implementation notes:**

- **`clock_in_user`/`clock_out_user` gained a third parameter, `p_geo_status`** (not in the abbreviated `(lat,lng)` signature in §4). "Denied" (user rejected the browser permission prompt) vs "unavailable" (permission granted, no fix obtained) are both client-side facts indistinguishable from null coordinates alone — the RPC can't infer which happened, so the client states it explicitly.
- **A real PL/pgSQL gotcha, caught by tests, not by inspection:** `record_variable IS NOT NULL` is unreliable for a plain `record`-typed variable populated via `SELECT ... INTO` — it evaluates `false` even when a row was genuinely found (confirmed directly against this Postgres version: `v IS NULL` is correct in both directions, but `v IS NOT NULL` is not). Every "was a row found" check in `clock_out_user` and `get_active_session_state` uses `NOT (v IS NULL)` instead. Checks that only test the not-found direction (`IF v IS NULL THEN raise ...`) were unaffected and needed no change. Worth grepping for this pattern (`record_var is not null`) before writing new RPCs in later milestones.
- **Notifications are deferred to M5.** §4's "Notifications emitted by RPCs" describes geofence breach → Template C as tied to `clock_in_user`/`clock_out_user`, but the dedupe-window insert helper is explicitly M5's own checklist item. M3 computes and stores `clock_in_outside_boundary`/`clock_out_outside_boundary` (its own explicit checklist item) but does not insert `NTF_Notification` rows yet — M5 needs to wire that in.
- **No work-arrangement configured at any level** (fresh org, nothing in `TIM_WorkArrangement`): defaults to `office` (flagged assumption, §11) so geofencing applies rather than silently not.
- **`getGeolocation()` has its own outer 6s timeout, separate from the 5s passed to `getCurrentPosition()`.** Caught by an e2e test hanging indefinitely: in headless Chromium with no permission grant, `getCurrentPosition` never calls either callback — the browser's permission-prompt wait isn't bounded by the `timeout` option (that only bounds waiting for a position *fix* once permission is already decided). A real user who leaves the OS/browser location prompt unanswered would hit the same hang. `lib/geolocation.ts` now races the browser call against its own timer so a punch's geo step always settles, matching the invariant that geolocation never blocks a punch.

### M4 — Corrections workflow

- [x] `submit_correction_request` (reason 1–500 enforced at RPC; 20/24h bucket) + UI from timesheet rows + missing-shift two-request flow (create_session then clock_out)
- [x] `approve_correction_request` / `reject_correction_request` (staleness guard, manager dept-scope check, audit before/after, Template D notification insert)
- [x] `admin_edit_locked_timecard` + admin UI (reason required, INVALID_TIME_RANGE)
- [x] Manager corrections queue grid (original vs requested, approve/reject, resolved-row slide-out, CORRECTION_ALREADY_RESOLVED toast on second-reviewer race) — see the M4 implementation note on where this lives before M5 builds the full `/dashboard`
- [x] Tests: TC-007/008/009 analogs; concurrent double-approve ⇒ one success one 409; originals never mutated except via approved branch

**AC:** full employee→manager round-trip works with notifications landing; race test deterministic-green.

**M4 implementation notes:**

- **Templates B and D are inserted directly, not deferred to M5.** Unlike Template C (geofence breach, deferred in M3 because it needs the 12h dedupe-window helper), B (submit → manager) and D (approve/reject → employee) need no dedupe — `private.create_notification()` is a plain insert, added in this migration. M5 still owns the dedupe-window helper for C/E and the bell/inbox UI that reads all of these.
- **`/dashboard` is scoped to just the corrections queue for now.** SPEC's route map puts the queue on `/dashboard` alongside a headcount widget, direct reports grid, and reports pane — those are M5's own checklist items. Rather than block M4's explicit "manager corrections queue" deliverable on M5 existing, `/dashboard` ships now with only the queue (plus the admin locked-timecard edit form) and redirects employees away; M5 adds the rest to the same route.
- **cb_start/cb_end/lb_start/lb_end corrections target "the most recent break of that type on the session."** `TIM_CorrectionRequest` has no `break_id` column — adding one would be exactly the kind of schema-widening the `create_session` note already warns against for missing shifts. `*_start` corrects the most recent break if one exists, else opens a new one (mirroring `create_session`'s "the record didn't fully exist yet" shape); `*_end` corrects the most recent break's end time and re-evaluates its violation.
- **`private.apply_correction(p_correction record)` takes a `record` parameter** — confirmed this is valid for a `plpgsql`-language function (unlike a plain SQL-language function, where it isn't) before relying on it.

### M5 — Notifications & manager dashboard

- [x] `NTF_Notification` insert helpers with dedupe-window logic (C: 12h pair-key; E: 24h session-key); Realtime publication + RLS
- [x] Bell + badge + popover inbox (mark-read, deep-links, spring badge pop, live insert without refresh)
- [x] Dashboard: headcount widget (live), Direct Reports grid with geofence column states incl. N/A (No GPS)
- [x] Reports pane: dept/employee filters, pay-cycle ranges anchored to `pay_cycle_start_date`, CSV export in org timezone, `report_export` bucket
- [x] Manager scope RLS verified in-grid AND via direct REST (TC-030 analog: no leakage outside managed depts); multi-dept manager sees union with Department column

**AC:** geofence breach generates exactly one Template C per 12h per pair under repeated punches; CSV timestamps match Asia/Manila.

**M5 implementation notes (in progress):**

- **`private.create_deduped_notification(...)` is the shared dedupe-window helper** both Template C and (later) Template E use: `exists (select 1 from NTF_Notification where dedupe_key = ... and created_at > now() - window)` → skip, else insert. It's a thin wrapper around the M4 `private.create_notification()` insert shape, just adding the dedupe check and the `dedupe_key`/`p_dedupe_window` params. `private.create_notification` itself is untouched — Templates B/D still use it directly since they don't dedupe.
- **Template C is now wired into `clock_in_user`/`clock_out_user`** (deferred from M3): both RPCs, after computing `v_outside`, call a new `private.notify_geofence_breach(org, department, employee_id, employee_name)` helper that resolves the department's manager (or every admin if unmanaged — the same fallback `submit_correction_request` uses for Template B) and calls the dedupe helper with key `geofence:{manager_id}:{employee_id}` and a 12h window. Both RPCs were re-`create or replace`d in the M5 migration rather than edited in place in the M3 migration file, matching the precedent already set for `custom_access_token_hook` in M2 — a plain function body change doesn't need a new column/table migration, but re-stating the full function in a new dated migration keeps each milestone's migration file an accurate record of what that milestone shipped.
- **Template E's actual call site is still M7's**, not M5's. SPEC's M5 bullet asks for the *dedupe-window logic* for both C and E, which `private.create_deduped_notification` already generically supports (any caller passing `dedupe_key`/`p_dedupe_window` gets the same exactly-once-per-window guarantee) — but the long-running-session *detector* is `auto_close_abandoned_breaks_and_sessions()`, an M7 pg_cron job that doesn't exist yet. M7 will call `private.create_deduped_notification(..., 'longrun:' || session_id, interval '24 hours')` once that job is written; no placeholder job is added here.
- **RLS/Realtime for `NTF_Notification` needed no changes** — M1's `ntf_notification_select_own`/`ntf_notification_update_own` policies and the `supabase_realtime` publication membership already cover Template C rows exactly like B/D/E/G (verified by reading, not re-migrating).
- **Notification center is a persistent header element, not its own route.** SPEC's route map lists it alongside routes but it's really "wherever the user is" (bell + popover inbox). Since only `/` had a nav header before M5 (other authenticated pages were bare `<h1>`s), a shared `AppHeader` server component (`components/features/navigation/AppHeader.tsx`) was introduced and wired into `/`, `/timesheet`, `/requests`, `/dashboard`, and `/admin` — it renders the page title, the existing role-gated nav links (previously duplicated only on `/`), and `NotificationBell`. This is a refactor of existing nav markup, not new nav design.
- **`NotificationBell` reads/writes `NTF_Notification` directly from the client, not through an RPC.** This is the one deliberate exception CLAUDE.md invariant #2 and the SPEC §3.2 note both already call out: recipient-side `is_read`/`read_at` mark-read is a column-restricted `GRANT UPDATE` + row policy, not an RPC. Initial notification list is fetched server-side (`AppHeader`, under RLS, passed down as a prop); new arrivals come via a `postgres_changes` Realtime subscription filtered to `recipient_id=eq.{userId}`; badge-pop animation is done by keying the badge span on `unreadCount` so remounting replays the CSS keyframe, avoiding an extra effect/ref pair.
- **`get_direct_reports_status()` is a read-only RPC, not a plain PostgREST select.** Per-row status (clocked in / on break / clocked out) and geofence state (Ok / Out of Bounds / N/A (WFH) / N/A (No GPS)) both require today's `TIM_WorkSession` + open-break lookups plus the same work-arrangement cascade `clock_in_user`/`clock_out_user` already use — not expressible as a flat client-side select, and doing it as N per-employee RPC calls (one per row) would be needlessly chatty. It's `SECURITY DEFINER` so it can read across the caller's managed department(s) regardless of RLS, but the role/org/department scoping it applies internally (manager → departments where `manager_id = auth.uid()`; admin → whole org; `is_active = true`; caller excluded) is the same shape RLS already enforces elsewhere, so no new access is actually granted — verified both by calling the RPC directly (`tests/rls/dashboard.test.ts`) and by the pre-existing M1 direct-REST no-leakage tests on `MST_User`/`TIM_WorkSession` (`tests/rls/rls.test.ts`), satisfying the AC's "in-grid AND via direct REST" requirement.
- **"Today" is computed in the organization's timezone**, not UTC or the server's clock — `MST_Organization.timezone` (default `Asia/Manila`) bounds the day-window for both the work-arrangement lookup date and which `TIM_WorkSession` rows count as "today's hours," consistent with CLAUDE.md's "org timezone for exports" convention.
- **The Department column is conditional, not role-based**: `DirectReportsGrid` shows it whenever the caller is an admin, or a manager whose visible rows span more than one distinct department — computed client-side from the returned rows rather than a second query, since the RPC already returns `department_id`/`department_name` per row.
- **Headcount widget and grid "live" updates refetch the whole RPC on any relevant Realtime event** (`TIM_WorkSession`/`TIM_CompensableBreak`/`TIM_NonCompensableBreak` insert/update) rather than patching individual rows client-side — at the ~50-employee scale this project targets, a full refetch is cheap and guarantees status/hours/geofence stay internally consistent instead of hand-merging partial CDC payloads.
- **`export_timesheet_report(...)` returns rows, not a raw CSV string** — PL/pgSQL never does CSV quoting/escaping; `ReportsPane` builds the actual CSV client-side (comma/quote/newline escaping) and triggers the download via a Blob + temporary `<a download>` click, matching the "client does formatting, RPC does data + authorization" split used everywhere else in this app. It's `SECURITY DEFINER` and rate-limited via the `report_export` bucket (CLAUDE.md invariant #8) — **deliberately not `stable`**, because `check_rate_limit()`/`log_audit_event()` both `INSERT`, and PostgREST routes `stable`/`immutable`-tagged functions through a read-only transaction; this is the identical bug class already hit and documented for `custom_access_token_hook` in M2, caught here by the Vitest suite (a `25006 cannot execute INSERT in a read-only transaction` error) before it shipped.
- **Filter arguments are validated against the caller's own scope inside the RPC**, not just trusted from the client: a manager passing `p_department_id`/`p_employee_id` for a department/employee they don't manage gets `UNAUTHORIZED`, even though the UI's own filter dropdowns (built from `get_direct_reports_status()`'s already-scoped rows) would never offer those values in the first place — defense in depth against a client bypassing its own UI.
- **Found and flagged, not fixed: `resolve_work_arrangement`'s "day" cascade uses UTC (`current_date`) in the M3 clock RPCs but org-local date in the M5 RPCs.** Building `get_direct_reports_status`/`export_timesheet_report` required computing "today" from `MST_Organization.timezone` explicitly (§11 item 5's pay-cycle discussion applies the same reasoning). Noticed along the way that `clock_in_user`/`clock_out_user` still pass Postgres's own `current_date` (UTC) to the same cascade — a real inconsistency for any org whose local midnight doesn't line up with UTC's, but changing M3 RPC behavior wasn't in scope for an M5 task; flagged as SPEC.md §11 item 10 instead of silently patched.

### M6 — Offline queue & sync

- [ ] `lib/offline` queue (localStorage schema per §8.1), enqueue on network failure, `online` listener
- [ ] Sync worker: sequential, backoff 2→32s ×5, conflict rows + manager notify, continue-past-failure
- [ ] Drift check (> 5:00 strictly, offline-duration discounted) ⇒ suspicious-drift log
- [ ] Idempotent-error dequeue rule (worker only); live UI still surfaces same codes as errors
- [ ] Playwright offline-simulation: punch offline → reconnect → single session server-side; duplicate-retry scenario produces zero false conflicts

**AC:** "successful call, lost response" scenario yields dequeue-no-conflict; overlap scenario yields conflict + notification.

### M7 — Jobs, compliance, avatars

- [ ] pg_cron jobs per §8.2 with idempotent re-run safety (E dedupe honored across 15-min cycles)
- [ ] `terminate_user` purge scheduling; anonymization function (transaction sequencing per §8.3 incl. NTF scrub); `force_anonymize_user`
- [ ] DSAR: `log_dsar_request` (+Template G) / `resolve_dsar_request`; admin DSAR screen; per-user CSV export for access requests
- [ ] Avatar Edge Function + Storage RLS prefix policies + profile upload UI (2MB/type errors surfaced)
- [ ] Admin screens: departments, work arrangements (cascade preview), holidays, org settings, audit log viewer (filter by action_type)
- [ ] Tests: anonymization leaves audit rows but no PII; auth.users row gone only after MST_User scrub commits; abandoned CB gets CB_OVERTIME, abandoned LB gets no flag

**AC:** run jobs manually against seeded fixtures — outcomes match §8.2/§8.3 exactly.

### M8 — Hardening & launch

- [ ] Backup workflow: weekly pg_dump → gpg-encrypt → private `backups` bucket + GH artifact (90d); prune >90d step; documented restore drill executed once
- [ ] Rate-limit sweep: every §6 bucket has a test that trips it and asserts 429 + RATE_LIMIT_TRIGGERED log
- [ ] Security pass: no service key client-side (bundle grep), no PII/tokens in logs, error messages toast-safe, storage prefixes locked
- [ ] a11y pass: contrast per brand table (coral never body-size text), focus-visible everywhere, reduced-motion verified, 44px targets
- [ ] Perf pass: skeleton thresholds, transform/opacity-only animations, punch p95 re-measured
- [ ] Browser matrix (last 2: Chrome/Edge/Safari/Firefox, desktop+mobile) incl. backdrop-filter fallback
- [ ] Domains attached (zedhr.com, www) + Namecheap records; production seed run; go-live checklist in README
- [ ] Forward-compat audit: grep confirms org access only via `getCurrentOrgId()`/`app_user_org_id()`; deviations fixed or documented

**AC:** all prior milestone ACs re-run green on a production-config preview; restore drill documented; launch checklist signed off.

---

## 11. Open items (flagged, not assumed)

1. **Vercel plan:** Hobby is non-commercial; Pro (~US$20/mo) is the compliant baseline — confirm before domain attach (M8).
2. **Supabase Auth mail deliverability:** built-in mailer is low-volume/best-effort; if invite deliverability disappoints, attach custom SMTP to Supabase Auth (config change only — do not add a provider SDK).
3. **Provider limits go stale:** verify current Supabase Auth rate/email thresholds and Vercel plan limits at build time (SRS §13.1) — never hardcode them as app logic.
4. **`min_lb_minutes` default:** SRS gives no default. The M1 migration ships the SPEC's own proposal (30) as the column default so M1 wasn't blocked on a synchronous confirmation — still needs Zed's sign-off; trivial follow-up migration if it should change.
5. **Pay-cycle range math** for the reports pane (weekly/biweekly/monthly anchored to `pay_cycle_start_date`) needs one worked example per cycle type approved before M5. M5 ships and uses the same best-effort `lib/payCycle.ts` implementation from M3 (same "wasn't blocked on synchronous confirmation" precedent as item 4) — still needs sign-off; the reports pane's date-range math has the identical edge-case surface as the timesheet page's.
6. **`AUD_SystemLog.action_type` registry** (§3.1): built without access to SRS §3.1's actual closed list; needs a pass against the real SRS to confirm naming/completeness before any client code starts depending on specific values.
7. **`MST_Organization.display_locale` / `pay_cycle_start_date` defaults:** SRS doesn't give defaults; M1 ships `en-PH` and `CURRENT_DATE` respectively as placeholders — confirm before these are surfaced in the UI (§9) or used in pay-cycle math (M5).
8. **MST_User "limited columns" for manager reads** (§3.2 row 3): M1 gives managers the full row for their managed department's members rather than a column-restricted view — see the M1 implementation note under §3.2. The M5 Direct Reports grid itself doesn't read `MST_User` directly (it goes through `get_direct_reports_status()`, which returns only `first_name`/`last_name`/`department_id`/`department_name` plus derived fields — no other column is exposed via that path), so the grid's own needs are resolved; the underlying RLS policy still hands managers the full row on a direct `MST_User` select, which is the part still open.
9. **Work-arrangement cascade default:** when nothing is configured at any level (org/department/user/day), M3's `resolve_work_arrangement()` defaults to `office`. Not specified in SPEC — a conservative choice so geofencing applies rather than silently not; confirm before M8 launch.
10. **`resolve_work_arrangement`'s "day" cascade is evaluated against Postgres's session `current_date` (UTC) in `clock_in_user`/`clock_out_user` (M3), but against the org's local calendar date in `get_direct_reports_status`/`export_timesheet_report` (M5, which explicitly compute `v_local_date` from `MST_Organization.timezone`).** For an org whose timezone crosses midnight at a different instant than UTC (true for every non-UTC timezone), a `target_level = 'day'` override dated "today" can resolve differently between a punch made right at clock-in time and the same day's dashboard/report view. Both M3 call sites should switch to the org-local date the same way M5's do — flagged here rather than silently changing M3 RPC behavior mid-M5.
11. **`report_export` rate-limit threshold (20/hour) is a placeholder**, same status as item 4's `min_lb_minutes` — SPEC gives no specific number for this bucket; confirm before M8 launch.
