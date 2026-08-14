export type AppJwtClaims = {
  sub: string;
  organization_id?: string;
  user_role?: "employee" | "manager" | "admin";
  role_changed_at?: string;
  aal?: "aal1" | "aal2";
};

/**
 * Decodes JWT claims without verifying the signature — only ever use this
 * to read UX hints (role/aal for redirects). The real security boundary is
 * RLS/RPCs, which independently re-derive these from the verified token
 * (CLAUDE.md invariant #1).
 */
export function decodeJwtClaims(token: string): AppJwtClaims {
  const payload = token.split(".")[1] ?? "";
  const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
  const json =
    typeof atob === "function"
      ? atob(padded.replace(/-/g, "+").replace(/_/g, "/"))
      : Buffer.from(padded, "base64url").toString("utf8");
  return JSON.parse(json);
}
