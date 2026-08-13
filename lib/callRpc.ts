import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * RPC error codes registry — SPEC.md §5. Adding a code here = update
 * SPEC.md §5 + traceability in the same PR (CLAUDE.md invariant #9-adjacent
 * discipline for the closed error-code list).
 */
const ERROR_ENVELOPES = {
  ERR_RATE_LIMITED: { http_status: 429, message: "You're doing that too often. Please wait and try again." },
  UNAUTHORIZED: { http_status: 403, message: "You don't have permission to do that." },
  MFA_REQUIRED: { http_status: 403, message: "Please verify your identity to continue." },
  ERR_USER_LIMIT_EXCEEDED: { http_status: 403, message: "This organization has reached its user limit." },
  ERR_VALIDATION: { http_status: 422, message: "Please check your input and try again." },
  USER_ALREADY_CLOCKED_IN: { http_status: 409, message: "You're already clocked in." },
  NO_ACTIVE_SESSION: { http_status: 404, message: "You don't have an active session." },
  BREAK_ALREADY_OPEN: { http_status: 409, message: "A break is already in progress." },
  NO_ACTIVE_BREAK: { http_status: 404, message: "There's no active break to end." },
  CORRECTION_NOT_FOUND: { http_status: 404, message: "That correction request couldn't be found." },
  CORRECTION_ALREADY_RESOLVED: { http_status: 409, message: "That correction request was already resolved." },
  EDIT_REASON_REQUIRED: { http_status: 422, message: "Please provide a reason for this edit." },
  SESSION_NOT_FOUND: { http_status: 404, message: "That session couldn't be found." },
  INVALID_TIME_RANGE: { http_status: 422, message: "Please check the time range and try again." },
  INVITATION_NOT_FOUND: { http_status: 404, message: "That invitation couldn't be found." },
  INVITATION_ALREADY_USED: { http_status: 409, message: "That invitation has already been used." },
  INVITATION_REVOKED: { http_status: 410, message: "That invitation has been revoked." },
  INVITATION_EXPIRED: { http_status: 410, message: "That invitation has expired." },
  PASSWORD_POLICY_VIOLATION: { http_status: 422, message: "Password must be at least 10 characters with a letter and a number." },
  USER_NOT_FOUND: { http_status: 404, message: "That user couldn't be found." },
  USER_NOT_TERMINATED: { http_status: 409, message: "That user hasn't been terminated." },
} as const;

export type RpcErrorCode = keyof typeof ERROR_ENVELOPES;

const UNKNOWN_ERROR_ENVELOPE = {
  code: "UNKNOWN_ERROR" as const,
  http_status: 500,
  message: "Something went wrong. Please try again.",
};

export type RpcErrorEnvelope = {
  code: RpcErrorCode | "UNKNOWN_ERROR";
  message: string;
  http_status: number;
};

export class RpcError extends Error {
  readonly code: RpcErrorEnvelope["code"];
  readonly http_status: number;

  constructor(envelope: RpcErrorEnvelope) {
    super(envelope.message);
    this.name = "RpcError";
    this.code = envelope.code;
    this.http_status = envelope.http_status;
  }

  /** `{ error: { code, message, http_status } }` per CLAUDE.md invariant #7. */
  toEnvelope(): { error: RpcErrorEnvelope } {
    return { error: { code: this.code, message: this.message, http_status: this.http_status } };
  }
}

function isRpcErrorCode(value: string): value is RpcErrorCode {
  return value in ERROR_ENVELOPES;
}

/**
 * The one shared helper for calling Postgres RPCs (CLAUDE.md invariant #7).
 * Maps `RAISE EXCEPTION 'CODE'` to a toast-safe error envelope. Call sites
 * never re-implement this mapping.
 */
export async function callRpc<TReturn = unknown>(
  supabase: SupabaseClient,
  fn: string,
  args?: Record<string, unknown>,
): Promise<TReturn> {
  const { data, error } = await supabase.rpc(fn, args);

  if (error) {
    const envelope = isRpcErrorCode(error.message)
      ? { code: error.message, ...ERROR_ENVELOPES[error.message] }
      : UNKNOWN_ERROR_ENVELOPE;

    throw new RpcError(envelope);
  }

  return data as TReturn;
}
