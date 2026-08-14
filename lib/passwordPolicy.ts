// SPEC §7: >=10 chars, >=1 letter, >=1 number. Mirrors
// private.validate_password_policy() in supabase/migrations — this is
// client-side inline feedback only; the RPC is the real enforcement.
export type PasswordRuleCheck = { label: string; met: boolean };

export function checkPasswordRules(password: string): PasswordRuleCheck[] {
  return [
    { label: "At least 10 characters", met: password.length >= 10 },
    { label: "At least one letter", met: /[A-Za-z]/.test(password) },
    { label: "At least one number", met: /[0-9]/.test(password) },
  ];
}

export function isPasswordValid(password: string): boolean {
  return checkPasswordRules(password).every((rule) => rule.met);
}
