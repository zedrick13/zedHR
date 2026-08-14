import { NextResponse } from "next/server";
import { httpStatusFor, toastMessageFor } from "@/lib/errorCodes";

/**
 * Route-Handler counterpart to lib/callRpc.ts's error envelope (CLAUDE.md
 * invariant #7: one uniform `{ error: { code, message, http_status } }`
 * shape everywhere) for the handful of privileged operations that go
 * through a Route Handler instead of a plain RPC (SPEC §2.2).
 */
export function apiError(code: string) {
  const http_status = httpStatusFor(code);
  return NextResponse.json(
    { error: { code, message: toastMessageFor(code), http_status } },
    { status: http_status },
  );
}
