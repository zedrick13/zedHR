// SPEC.md §5 — error codes registry. Adding a code = update this file + §5 in the same PR.
export const ERROR_CODES = {
  ERR_RATE_LIMITED: 429,
  UNAUTHORIZED: 403,
  MFA_REQUIRED: 403,
  ERR_USER_LIMIT_EXCEEDED: 403,
  ERR_VALIDATION: 422,
  USER_ALREADY_CLOCKED_IN: 409,
  NO_ACTIVE_SESSION: 404,
  BREAK_ALREADY_OPEN: 409,
  NO_ACTIVE_BREAK: 404,
  CORRECTION_NOT_FOUND: 404,
  CORRECTION_ALREADY_RESOLVED: 409,
  EDIT_REASON_REQUIRED: 422,
  SESSION_NOT_FOUND: 404,
  INVALID_TIME_RANGE: 422,
  INVITATION_NOT_FOUND: 404,
  INVITATION_ALREADY_USED: 409,
  INVITATION_REVOKED: 410,
  INVITATION_EXPIRED: 410,
  PASSWORD_POLICY_VIOLATION: 422,
  USER_NOT_FOUND: 404,
  USER_NOT_TERMINATED: 409,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

const TOAST_MESSAGES: Record<ErrorCode, string> = {
  ERR_RATE_LIMITED: "You're doing that too often. Please wait a moment and try again.",
  UNAUTHORIZED: "You don't have permission to do that.",
  MFA_REQUIRED: "Please verify with your authenticator app to continue.",
  ERR_USER_LIMIT_EXCEEDED: "This organization has reached its user limit.",
  ERR_VALIDATION: "Please check your input and try again.",
  USER_ALREADY_CLOCKED_IN: "You're already clocked in.",
  NO_ACTIVE_SESSION: "You don't have an active shift.",
  BREAK_ALREADY_OPEN: "You're already on a break.",
  NO_ACTIVE_BREAK: "You don't have an active break.",
  CORRECTION_NOT_FOUND: "That correction request couldn't be found.",
  CORRECTION_ALREADY_RESOLVED: "That request was already resolved.",
  EDIT_REASON_REQUIRED: "A reason is required for this edit.",
  SESSION_NOT_FOUND: "That shift couldn't be found.",
  INVALID_TIME_RANGE: "The times entered aren't valid.",
  INVITATION_NOT_FOUND: "That invitation couldn't be found.",
  INVITATION_ALREADY_USED: "That invitation has already been used.",
  INVITATION_REVOKED: "That invitation was revoked.",
  INVITATION_EXPIRED: "That invitation has expired.",
  PASSWORD_POLICY_VIOLATION:
    "Password must be at least 10 characters with a letter and a number.",
  USER_NOT_FOUND: "That user couldn't be found.",
  USER_NOT_TERMINATED: "That user isn't terminated.",
};

export function isErrorCode(code: string): code is ErrorCode {
  return code in ERROR_CODES;
}

export function toastMessageFor(code: string): string {
  if (isErrorCode(code)) {
    return TOAST_MESSAGES[code];
  }
  return "Something went wrong. Please try again.";
}

export function httpStatusFor(code: string): number {
  if (isErrorCode(code)) {
    return ERROR_CODES[code];
  }
  return 500;
}
