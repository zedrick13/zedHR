-- SPEC.md M8: private "backups" storage bucket (§2.1's "Storage (avatars
-- public bucket, backups private bucket)"). Deliberately no RLS policies
-- for anon/authenticated are added here — storage.objects has RLS enabled
-- by default, so with zero permissive policies this bucket is unreachable
-- by any client-facing role and is written/read/pruned only by the
-- service-role key, exactly like the weekly backup workflow needs
-- (CLAUDE.md: "SUPABASE_SERVICE_ROLE_KEY exists only in Vercel server-side
-- env and Edge Function secrets" — the GitHub Actions backup workflow's
-- copy is the one deliberate carve-out, held as a repo secret, never
-- client-reachable).

insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;
