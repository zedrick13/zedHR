import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * The single source of org resolution (SPEC §2.4). Today: the signed-in
 * user's MST_User.organization_id. Phase 1 multi-tenant swaps this body to
 * resolve from subdomain — callers never change. No other code may derive
 * organization_id directly.
 */
export async function getCurrentOrgId(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("UNAUTHORIZED");
  }

  const { data, error } = await supabase
    .from("MST_User")
    .select("organization_id")
    .eq("id", user.id)
    .single();

  if (error || !data) {
    throw new Error("UNAUTHORIZED");
  }

  return data.organization_id;
}
