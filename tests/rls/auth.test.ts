// M2 auth/invitation/MFA RPC suite. Same live-Supabase-required, graceful
// skip pattern as tests/rls/rls.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { adminClient, anonClient, grantAal2, isSupabaseReachable, signInAs } from "./client";
import { createOrg, createUser } from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn("\n[tests/rls] Local Supabase isn't reachable — skipping the M2 auth suite.\n");
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
  return JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
}

describe.skipIf(!reachable)("M2 auth RPCs", () => {
  const admin = adminClient();
  let orgId: string;
  let adminUser: { id: string; email: string; password: string };
  let adminAal2Client: SupabaseClient<Database>;

  beforeAll(async () => {
    orgId = await createOrg(admin);
    adminUser = await createUser(admin, { organizationId: orgId, role: "admin" });
    adminAal2Client = await signInAs(adminUser.email, adminUser.password);
    await grantAal2(adminAal2Client);
  }, 30_000);

  describe("login lockout", () => {
    it("allows attempts under the threshold, blocks at 5/15min", async () => {
      const anon = anonClient();
      const email = `lockout-${crypto.randomUUID()}@zedhr.test`;

      const first = await anon.rpc("check_login_allowed", { p_email: email });
      expect(first.error).toBeNull();

      for (let i = 0; i < 5; i++) {
        const { error } = await anon.rpc("record_login_failure", { p_email: email });
        expect(error).toBeNull();
      }

      const sixth = await anon.rpc("check_login_allowed", { p_email: email });
      expect(sixth.error?.message).toBe("ERR_RATE_LIMITED");

      const { data: auditRows } = await admin
        .from("AUD_SystemLog")
        .select("action_type")
        .eq("action_type", "LOGIN_LOCKOUT")
        .contains("new_value", { email });
      expect(auditRows).toHaveLength(1);
    });
  });

  describe("accept_invitation", () => {
    it("full flow: create -> invite-created user signs in -> accepts -> new password works", async () => {
      const email = `newhire-${crypto.randomUUID()}@zedhr.test`;

      const { data: invite, error: inviteError } = await adminAal2Client.rpc("create_invitation", {
        p_email: email,
        p_role: "employee",
      });
      expect(inviteError).toBeNull();
      const { invitation_token: token } = invite![0];

      const tempPassword = "TempOnboard1";
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
      });
      expect(createError).toBeNull();

      const invitedClient = await signInAs(email, tempPassword);

      const weak = await invitedClient.rpc("accept_invitation", {
        p_token: token,
        p_password: "short",
        p_first_name: "New",
        p_last_name: "Hire",
      });
      expect(weak.error?.message).toBe("PASSWORD_POLICY_VIOLATION");

      const accept = await invitedClient.rpc("accept_invitation", {
        p_token: token,
        p_password: "RealPassw0rd",
        p_first_name: "New",
        p_last_name: "Hire",
      });
      expect(accept.error).toBeNull();

      const reaccept = await invitedClient.rpc("accept_invitation", {
        p_token: token,
        p_password: "AnotherPassw0rd",
        p_first_name: "New",
        p_last_name: "Hire",
      });
      expect(reaccept.error?.message).toBe("INVITATION_ALREADY_USED");

      const relogin = await signInAs(email, "RealPassw0rd");
      const { data: userData } = await relogin.auth.getUser();
      expect(userData.user?.id).toBe(created!.user!.id);
    });
  });

  describe("MFA backup codes", () => {
    it("generates 8 codes, verifies once, grants aal2 on next refresh", async () => {
      const email = `mfauser-${crypto.randomUUID()}@zedhr.test`;
      const password = "TempOnboard1";
      await admin.auth.admin.createUser({ email, password, email_confirm: true });
      const { data: invite } = await adminAal2Client.rpc("create_invitation", {
        p_email: email,
        p_role: "employee",
      });
      const invitedClient = await signInAs(email, password);
      await invitedClient.rpc("accept_invitation", {
        p_token: invite![0].invitation_token,
        p_password: "RealPassw0rd",
        p_first_name: "Mfa",
        p_last_name: "User",
      });

      const relogin = await signInAs(email, "RealPassw0rd");
      await grantAal2(relogin);

      const { data: codes, error: codesError } = await relogin.rpc("generate_mfa_backup_codes");
      expect(codesError).toBeNull();
      expect(codes).toHaveLength(8);

      const fresh = await signInAs(email, "RealPassw0rd");
      const { data: freshSession } = await fresh.auth.getSession();
      expect(decodeJwtClaims(freshSession.session!.access_token).aal).toBe("aal1");

      const verify = await fresh.rpc("verify_backup_code", { p_code: codes![0] });
      expect(verify.error).toBeNull();

      const reuse = await fresh.rpc("verify_backup_code", { p_code: codes![0] });
      expect(reuse.error?.message).toBe("INVALID_MFA_CODE");

      const { data: refreshed, error: refreshError } = await fresh.auth.refreshSession();
      expect(refreshError).toBeNull();
      expect(decodeJwtClaims(refreshed.session!.access_token).aal).toBe("aal2");
    });
  });

  describe("admin RPCs require admin + aal2", () => {
    it("change_user_role rejects a non-admin caller", async () => {
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });
      const employeeClient = await signInAs(employee.email, employee.password);

      const { error } = await employeeClient.rpc("change_user_role", {
        p_user_id: employee.id,
        p_new_role: "admin",
      });
      expect(error?.message).toBe("UNAUTHORIZED");
    });

    it("terminate_user succeeds for an aal2 admin and sets is_active=false", async () => {
      const target = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { error } = await adminAal2Client.rpc("terminate_user", { p_user_id: target.id });
      expect(error).toBeNull();

      const { data } = await admin.from("MST_User").select("is_active").eq("id", target.id).single();
      expect(data?.is_active).toBe(false);
    });
  });
});
