// M8 rate-limit sweep (SPEC.md §6 / §10): every bucket must have a test
// that actually trips the limit and asserts both the ERR_RATE_LIMITED
// error and a RATE_LIMIT_TRIGGERED (or bucket-specific, e.g. LOGIN_LOCKOUT)
// AUD_SystemLog row. `login:{email}` and `report_export:{user_id}` already
// had trip tests before this sweep (tests/rls/auth.test.ts,
// tests/rls/dashboard.test.ts) — this file added the missing audit-log
// assertion to both in place rather than duplicating them here. This file
// covers the remaining buckets that had no trip test at all:
// `clock_action:{user_id}`, `correction_submit:{user_id}`,
// `invitation_accept:{token}`, `password_reset_request:{email}`.
//
// `avatar_upload:{user_id}` (the 7th bucket) is deliberately NOT covered
// here: it's enforced inside the get_avatar_upload_url Edge Function, and
// `supabase functions serve` cannot run in this sandbox (the same
// container-runtime privilege error documented since M7) — there is no
// live Edge Function to call. The rate-limit/audit-log code was read and
// fixed by hand (SPEC.md's M8 implementation notes) instead of exercised
// by a test; flagged in SPEC.md §11 as a real item to verify against a
// deployed environment before launch.
import { describe, expect, it } from "vitest";
import { adminClient, anonClient, isSupabaseReachable, rpc, signInAs } from "./client";
import { createOrg, createUser, createWorkSession } from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn("\n[tests/rls] Local Supabase isn't reachable — skipping the M8 rate-limit sweep.\n");
}

describe.skipIf(!reachable)("M8 rate-limit sweep", () => {
  const admin = adminClient();

  it("trips clock_action:{user_id} at 10/60s and audits it", async () => {
    const orgId = await createOrg(admin);
    const employee = await createUser(admin, { organizationId: orgId, role: "employee" });
    const client = await signInAs(employee.email, employee.password);

    for (let i = 0; i < 5; i++) {
      const clockIn = await rpc(client, "clock_in_user", { p_lat: null, p_lng: null, p_geo_status: "unavailable" });
      expect(clockIn.error).toBeNull();
      const clockOut = await rpc(client, "clock_out_user", { p_lat: null, p_lng: null, p_geo_status: "unavailable" });
      expect(clockOut.error).toBeNull();
    }

    const { error: blocked } = await rpc(client, "clock_in_user", {
      p_lat: null,
      p_lng: null,
      p_geo_status: "unavailable",
    });
    expect(blocked?.message).toBe("ERR_RATE_LIMITED");

    const { data: auditRows } = await admin
      .from("AUD_SystemLog")
      .select("action_type")
      .eq("actor_id", employee.id)
      .eq("action_type", "RATE_LIMIT_TRIGGERED");
    expect(auditRows).toHaveLength(1);
  });

  it("trips correction_submit:{user_id} at 20/24h and audits it", async () => {
    const orgId = await createOrg(admin);
    const employee = await createUser(admin, { organizationId: orgId, role: "employee" });
    const sessionId = await createWorkSession(admin, { userId: employee.id, organizationId: orgId });
    const client = await signInAs(employee.email, employee.password);

    for (let i = 0; i < 20; i++) {
      const { error } = await rpc(client, "submit_correction_request", {
        p_work_session_id: sessionId,
        p_request_type: "clock_in",
        p_requested_timestamp: new Date().toISOString(),
        p_reason: `sweep attempt ${i}`,
      });
      expect(error).toBeNull();
    }

    const { error: blocked } = await rpc(client, "submit_correction_request", {
      p_work_session_id: sessionId,
      p_request_type: "clock_in",
      p_requested_timestamp: new Date().toISOString(),
      p_reason: "sweep attempt 21",
    });
    expect(blocked?.message).toBe("ERR_RATE_LIMITED");

    const { data: auditRows } = await admin
      .from("AUD_SystemLog")
      .select("action_type")
      .eq("actor_id", employee.id)
      .eq("action_type", "RATE_LIMIT_TRIGGERED");
    expect(auditRows).toHaveLength(1);
  });

  it("trips invitation_accept:{token} at 10/10min and audits it", async () => {
    // Rate-limit-first (CLAUDE.md invariant #8) means every call counts
    // against the token-keyed bucket regardless of whether the token is
    // real — a bogus, never-issued token is enough to trip it. accept_invitation
    // runs authenticated (M2 note), so any signed-in user can be the caller.
    const orgId = await createOrg(admin);
    const employee = await createUser(admin, { organizationId: orgId, role: "employee" });
    const client = await signInAs(employee.email, employee.password);
    const bogusToken = `sweep-bogus-token-${crypto.randomUUID()}`;

    for (let i = 0; i < 10; i++) {
      const { error } = await rpc(client, "accept_invitation", {
        p_token: bogusToken,
        p_password: "Sweep-test-pw1",
        p_first_name: "Sweep",
        p_last_name: "Test",
      });
      expect(error?.message).toBe("INVITATION_NOT_FOUND");
    }

    const { error: blocked } = await rpc(client, "accept_invitation", {
      p_token: bogusToken,
      p_password: "Sweep-test-pw1",
      p_first_name: "Sweep",
      p_last_name: "Test",
    });
    expect(blocked?.message).toBe("ERR_RATE_LIMITED");

    const { data: auditRows } = await admin
      .from("AUD_SystemLog")
      .select("action_type")
      .eq("actor_id", employee.id)
      .eq("action_type", "RATE_LIMIT_TRIGGERED");
    expect(auditRows).toHaveLength(1);
  });

  it("trips password_reset_request:{email} at 3/60min and audits it", async () => {
    const anon = anonClient();
    const email = `sweep-reset-${crypto.randomUUID()}@zedhr.test`;

    for (let i = 0; i < 3; i++) {
      const { error } = await anon.rpc("check_password_reset_allowed", { p_email: email });
      expect(error).toBeNull();
    }

    const { error: blocked } = await anon.rpc("check_password_reset_allowed", { p_email: email });
    expect(blocked?.message).toBe("ERR_RATE_LIMITED");

    const { data: auditRows } = await admin
      .from("AUD_SystemLog")
      .select("action_type")
      .eq("action_type", "RATE_LIMIT_TRIGGERED")
      .contains("new_value", { email });
    expect(auditRows).toHaveLength(1);
  });
});
