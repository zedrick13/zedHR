import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc } from "@/lib/callRpc";
import type { Database } from "@/lib/database.types";

function fakeSupabase(
  result: { data: unknown; error: { message: string } | null },
) {
  return {
    rpc: async () => result,
  } as unknown as SupabaseClient<Database>;
}

describe("callRpc", () => {
  it("returns data on success", async () => {
    const supabase = fakeSupabase({ data: { ok: true }, error: null });
    const result = await callRpc(supabase, "get_active_session_state");
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ ok: true });
  });

  it("maps a RAISE EXCEPTION code to the uniform error envelope", async () => {
    const supabase = fakeSupabase({
      data: null,
      error: { message: "USER_ALREADY_CLOCKED_IN" },
    });
    const result = await callRpc(supabase, "clock_in_user");
    expect(result.data).toBeNull();
    expect(result.error).toEqual({
      code: "USER_ALREADY_CLOCKED_IN",
      message: "You're already clocked in.",
      http_status: 409,
    });
  });

  it("falls back to a generic toast-safe message for unknown codes", async () => {
    const supabase = fakeSupabase({
      data: null,
      error: { message: "unexpected_pg_error" },
    });
    const result = await callRpc(supabase, "clock_in_user");
    expect(result.error?.code).toBe("unexpected_pg_error");
    expect(result.error?.message).toBe(
      "Something went wrong. Please try again.",
    );
    expect(result.error?.http_status).toBe(500);
  });
});
