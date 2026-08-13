import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc, RpcError } from "@/lib/callRpc";

function fakeSupabase(rpcResult: { data?: unknown; error?: { message: string } }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as SupabaseClient;
}

describe("callRpc", () => {
  it("returns data on success", async () => {
    const supabase = fakeSupabase({ data: "pong" });

    await expect(callRpc<string>(supabase, "ping")).resolves.toBe("pong");
  });

  it("maps a known RAISE EXCEPTION code to its toast-safe envelope", async () => {
    const supabase = fakeSupabase({ error: { message: "USER_ALREADY_CLOCKED_IN" } });

    const err = await callRpc(supabase, "clock_in_user").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe("USER_ALREADY_CLOCKED_IN");
    expect((err as RpcError).http_status).toBe(409);
    expect((err as RpcError).message).not.toMatch(/SQL|postgres|stack/i);
  });

  it("falls back to UNKNOWN_ERROR for unrecognized error messages, never leaking raw text", async () => {
    const supabase = fakeSupabase({
      error: { message: 'duplicate key value violates unique constraint "idx_open_work_session"' },
    });

    const err = await callRpc(supabase, "clock_in_user").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe("UNKNOWN_ERROR");
    expect((err as RpcError).http_status).toBe(500);
    expect((err as RpcError).message).not.toMatch(/idx_open_work_session|constraint/i);
  });
});
