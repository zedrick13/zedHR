import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * Service-role client. SUPABASE_SERVICE_ROLE_KEY is server-only (Vercel env /
 * Edge Function secrets) and must never reach a client bundle. Import this
 * only from the small set of Route Handlers that perform privileged Admin
 * API calls (SPEC §2.2) — everything else goes through RPCs under RLS.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
