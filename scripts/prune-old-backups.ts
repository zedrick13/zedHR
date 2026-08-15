/**
 * Deletes objects in the private `backups` Storage bucket older than 90
 * days (SPEC.md §10 M8's "prune >90d step"). Run by the weekly backup
 * GitHub Actions workflow after each upload; also safe to run manually.
 *
 * Usage:
 *   SUPABASE_SERVICE_ROLE_KEY=... NEXT_PUBLIC_SUPABASE_URL=... pnpm tsx scripts/prune-old-backups.ts
 */
import { createClient } from "@supabase/supabase-js";

const RETENTION_DAYS = 90;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const supabase = createClient(url, serviceRoleKey);
  const { data: objects, error } = await supabase.storage.from("backups").list();
  if (error) throw error;

  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const stale = (objects ?? []).filter((object) => {
    const createdAtMs = object.created_at ? new Date(object.created_at).getTime() : NaN;
    return Number.isFinite(createdAtMs) && createdAtMs < cutoffMs;
  });

  if (stale.length === 0) {
    console.log("No backups older than 90 days — nothing to prune.");
    return;
  }

  const { error: removeError } = await supabase.storage.from("backups").remove(stale.map((object) => object.name));
  if (removeError) throw removeError;
  console.log(`Pruned ${stale.length} backup(s) older than ${RETENTION_DAYS} days:`, stale.map((o) => o.name));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
