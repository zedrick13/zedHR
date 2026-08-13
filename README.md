# zedHR Timekeeping

See `CLAUDE.md` for project conventions and `SPEC.md` for the full implementation spec (schema, RLS, RPC contracts, milestones).

## Getting started

```bash
pnpm install
pnpm dev                 # Next.js dev server
supabase start           # local stack (Docker)
supabase db reset        # rebuild local DB from migrations + seed
pnpm test                # Vitest (unit + RLS tests against local supabase)
pnpm test:e2e            # Playwright
pnpm lint && pnpm typecheck
```

Copy `.env.example` to `.env.local` and fill in your local Supabase project's URL/keys before running.
