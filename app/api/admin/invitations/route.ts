import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/apiEnvelope";

// SPEC §2.2: this Route Handler holds the service-role key only for the one
// thing that needs it (triggering Supabase Auth's mailer). Authorization
// (admin + aal2) is enforced by create_invitation itself, called through the
// caller's own session — the service-role client never makes that decision.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const role = typeof body?.role === "string" ? body.role : "";

  if (!email || !["employee", "manager", "admin"].includes(role)) {
    return apiError("ERR_VALIDATION");
  }

  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc("create_invitation", {
    p_email: email,
    p_role: role,
  });

  if (error || !data?.[0]) {
    return apiError(error?.message ?? "ERR_VALIDATION");
  }

  const { invitation_token: token } = data[0];
  const origin = new URL(request.url).origin;

  const admin = createAdminClient();
  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/invite/${token}`,
  });

  if (inviteError) {
    return apiError("ERR_VALIDATION");
  }

  return NextResponse.json({ data: { success: true }, error: null });
}
