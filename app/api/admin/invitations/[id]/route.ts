import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/apiEnvelope";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createServerClient();

  const { error } = await supabase.rpc("revoke_invitation", { p_invitation_id: id });

  if (error) {
    return apiError(error.message);
  }

  return NextResponse.json({ data: { success: true }, error: null });
}
