import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/apiEnvelope";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createServerClient();

  // Authorization (admin + aal2) lives in admin_reset_mfa itself.
  const { error } = await supabase.rpc("admin_reset_mfa", { p_user_id: id });
  if (error) {
    return apiError(error.message);
  }

  // Best-effort: also remove the target's enrolled TOTP factor(s) via the
  // Admin API, so they get a fresh QR code on re-enrollment rather than
  // hitting max_enrolled_factors. Not fatal if this part fails — the DB-side
  // reset (mfa_enrolled=false, backup codes cleared) already succeeded.
  try {
    const admin = createAdminClient();
    const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId: id });
    for (const factor of factors?.factors ?? []) {
      await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: id });
    }
  } catch {
    // Swallow — see comment above.
  }

  return NextResponse.json({ data: { success: true }, error: null });
}
