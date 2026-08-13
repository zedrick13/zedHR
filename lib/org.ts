import { createClient } from "@/lib/supabase/server";

interface CurrentUserOrgRow {
  organization_id: string;
}

/**
 * The single org-resolution helper (SPEC.md §2.4). Today: the signed-in
 * user's MST_User.organization_id. Phase 1 multi-tenant will resolve this
 * from the request subdomain instead — no other code may derive the org.
 */
export async function getCurrentOrgId(): Promise<string> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("getCurrentOrgId() called without an authenticated user.");
  }

  const { data, error } = await supabase
    .from("MST_User")
    .select("organization_id")
    .eq("id", user.id)
    .single<CurrentUserOrgRow>();

  if (error || !data) {
    throw new Error("Unable to resolve the current user's organization.");
  }

  return data.organization_id;
}
