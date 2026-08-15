import type { SupabaseClient } from "@supabase/supabase-js";
import { httpStatusFor, toastMessageFor } from "@/lib/errorCodes";

export type ErrorEnvelope = {
  code: string;
  message: string;
  http_status: number;
};

export type CallRpcResult<T> =
  | { data: T; error: null }
  | { data: null; error: ErrorEnvelope };

/**
 * The one place that maps a Postgres `RAISE EXCEPTION 'CODE'` (surfaced by
 * PostgREST as PostgrestError.message) to the uniform error envelope
 * (CLAUDE.md invariant #7). Call sites never re-implement this mapping and
 * never inspect PostgrestError directly.
 *
 * RPC argument/return shapes stay `unknown`-in, generic-out here rather than
 * derived from Database["public"]["Functions"] because that map is empty
 * until the M1 migrations exist and types are generated; call sites supply
 * the return type via the `T` parameter. `supabase` is intentionally
 * untyped-by-Database here (only `.rpc` is used) so this helper doesn't
 * need updating when the generated types land.
 */
export async function callRpc<T = unknown>(
  supabase: SupabaseClient,
  fn: string,
  args?: Record<string, unknown>,
): Promise<CallRpcResult<T>> {
  const { data, error } = await supabase.rpc(fn, args);

  if (error) {
    // plpgsql `RAISE EXCEPTION 'CODE'` arrives as error.message === 'CODE'.
    const code = error.message?.trim() || "UNKNOWN";
    return {
      data: null,
      error: {
        code,
        message: toastMessageFor(code),
        http_status: httpStatusFor(code),
      },
    };
  }

  return { data: data as T, error: null };
}
