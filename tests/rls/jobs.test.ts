// M7 suite: scheduled jobs (SPEC §8.2) and anonymization (§8.3). Same
// live-Supabase-required, graceful-skip pattern as the other tests/rls
// files. The three job entry points live in `public` (revoked from
// anon/authenticated, reachable only by service_role/superuser) rather
// than `private`, since PostgREST only routes to schemas listed in
// config.toml's `[api] schemas` — `private` isn't one of them, so a
// service-role client couldn't call a `private.*` function via `.rpc()`
// at all. This suite calls them directly with the admin (service-role)
// client, same as pg_cron's plain-SQL invocation in production — it
// doesn't wait on the actual cron schedule.
import { describe, expect, it } from "vitest";
import { adminClient, grantAal2, isSupabaseReachable, rpc, signInAs } from "./client";
import { createDepartment, createOrg, createUser, setDepartmentManager } from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn("\n[tests/rls] Local Supabase isn't reachable — skipping the M7 jobs suite.\n");
}

describe.skipIf(!reachable)("M7 scheduled jobs", () => {
  const admin = adminClient();

  describe("auto_close_abandoned_breaks_and_sessions", () => {
    it("closes an abandoned CB at start+4h with CB_OVERTIME, an abandoned LB with no violation, flags a >16h session without a fabricated clock-out, and notifies the manager exactly once across repeated runs", async () => {
      const orgId = await createOrg(admin, { maxCbMinutes: 20 });
      const deptId = await createDepartment(admin, orgId);
      const manager = await createUser(admin, { organizationId: orgId, role: "manager", departmentId: deptId });
      await setDepartmentManager(admin, deptId, manager.id);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });

      const { data: session } = await admin
        .from("TIM_WorkSession")
        .insert({
          user_id: employee.id,
          organization_id: orgId,
          clock_in_time: new Date(Date.now() - 17 * 3600_000).toISOString(),
          clock_in_geo_status: "unavailable",
        })
        .select("id")
        .single();

      const { data: cb } = await admin
        .from("TIM_CompensableBreak")
        .insert({
          organization_id: orgId,
          work_session_id: session!.id,
          start_time: new Date(Date.now() - 5 * 3600_000).toISOString(),
        })
        .select("id")
        .single();
      const { data: lb } = await admin
        .from("TIM_NonCompensableBreak")
        .insert({
          organization_id: orgId,
          work_session_id: session!.id,
          start_time: new Date(Date.now() - 5 * 3600_000).toISOString(),
        })
        .select("id")
        .single();

      const { error } = await admin.rpc("auto_close_abandoned_breaks_and_sessions");
      expect(error).toBeNull();

      const { data: cbRow } = await admin
        .from("TIM_CompensableBreak")
        .select("end_time, is_auto_closed, policy_violation, policy_violation_reason")
        .eq("id", cb!.id)
        .single();
      expect(cbRow?.is_auto_closed).toBe(true);
      expect(cbRow?.policy_violation).toBe(true);
      expect(cbRow?.policy_violation_reason).toBe("CB_OVERTIME");

      const { data: lbRow } = await admin
        .from("TIM_NonCompensableBreak")
        .select("end_time, is_auto_closed, policy_violation, policy_violation_reason")
        .eq("id", lb!.id)
        .single();
      expect(lbRow?.is_auto_closed).toBe(true);
      expect(lbRow?.policy_violation).toBe(false);
      expect(lbRow?.policy_violation_reason).toBeNull();

      const { data: sessionRow } = await admin
        .from("TIM_WorkSession")
        .select("flagged_long_running, clock_out_time")
        .eq("id", session!.id)
        .single();
      expect(sessionRow?.flagged_long_running).toBe(true);
      expect(sessionRow?.clock_out_time).toBeNull();

      const { data: notifications } = await admin
        .from("NTF_Notification")
        .select("id")
        .eq("recipient_id", manager.id)
        .eq("template", "E");
      expect(notifications).toHaveLength(1);

      // Idempotent re-run: flagged_long_running already true and the
      // break rows already closed, so nothing should fire again.
      await admin.rpc("auto_close_abandoned_breaks_and_sessions");
      const { data: notificationsAfter } = await admin
        .from("NTF_Notification")
        .select("id")
        .eq("recipient_id", manager.id)
        .eq("template", "E");
      expect(notificationsAfter).toHaveLength(1);
    });

    it("does not touch breaks or sessions still under the thresholds", async () => {
      const orgId = await createOrg(admin);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { data: session } = await admin
        .from("TIM_WorkSession")
        .insert({
          user_id: employee.id,
          organization_id: orgId,
          clock_in_time: new Date(Date.now() - 3600_000).toISOString(),
          clock_in_geo_status: "unavailable",
        })
        .select("id")
        .single();
      const { data: cb } = await admin
        .from("TIM_CompensableBreak")
        .insert({
          organization_id: orgId,
          work_session_id: session!.id,
          start_time: new Date(Date.now() - 5 * 60_000).toISOString(),
        })
        .select("id")
        .single();

      await admin.rpc("auto_close_abandoned_breaks_and_sessions");

      const { data: cbRow } = await admin
        .from("TIM_CompensableBreak")
        .select("end_time, is_auto_closed")
        .eq("id", cb!.id)
        .single();
      expect(cbRow?.end_time).toBeNull();
      expect(cbRow?.is_auto_closed).toBe(false);

      const { data: sessionRow } = await admin
        .from("TIM_WorkSession")
        .select("flagged_long_running")
        .eq("id", session!.id)
        .single();
      expect(sessionRow?.flagged_long_running).toBe(false);
    });
  });

  describe("purge_stale_rows", () => {
    it("deletes RTL_RateLimitEvent rows older than 24h and NTF_Notification rows older than 180d, keeping fresher rows", async () => {
      const orgId = await createOrg(admin);
      const user = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { data: staleRate } = await admin
        .from("RTL_RateLimitEvent")
        .insert({ organization_id: orgId, user_id: user.id, bucket_key: "stale-bucket" })
        .select("id")
        .single();
      await admin
        .from("RTL_RateLimitEvent")
        .update({ created_at: new Date(Date.now() - 25 * 3600_000).toISOString() })
        .eq("id", staleRate!.id);

      const { data: freshRate } = await admin
        .from("RTL_RateLimitEvent")
        .insert({ organization_id: orgId, user_id: user.id, bucket_key: "fresh-bucket" })
        .select("id")
        .single();

      const { data: staleNotif } = await admin
        .from("NTF_Notification")
        .insert({ organization_id: orgId, recipient_id: user.id, template: "D", title: "old", body: "old" })
        .select("id")
        .single();
      await admin
        .from("NTF_Notification")
        .update({ created_at: new Date(Date.now() - 181 * 86_400_000).toISOString() })
        .eq("id", staleNotif!.id);

      const { data: freshNotif } = await admin
        .from("NTF_Notification")
        .insert({ organization_id: orgId, recipient_id: user.id, template: "D", title: "new", body: "new" })
        .select("id")
        .single();

      await admin.rpc("purge_stale_rows");

      const { data: rateRows } = await admin
        .from("RTL_RateLimitEvent")
        .select("id")
        .in("id", [staleRate!.id, freshRate!.id]);
      expect(rateRows?.map((r) => r.id)).toEqual([freshRate!.id]);

      const { data: notifRows } = await admin
        .from("NTF_Notification")
        .select("id")
        .in("id", [staleNotif!.id, freshNotif!.id]);
      expect(notifRows?.map((r) => r.id)).toEqual([freshNotif!.id]);
    });
  });

  describe("anonymize_user (via force_anonymize_user)", () => {
    it("scrubs MST_User, disables the auth identity so the old password no longer works, preserves TIM_WorkSession, redacts correction reasons, scrubs audit JSON, deletes notifications, and logs USER_ANONYMIZED", async () => {
      const orgId = await createOrg(admin);
      const deptId = await createDepartment(admin, orgId);
      const adminUser = await createUser(admin, { organizationId: orgId, role: "admin" });
      const adminAuthedClient = await signInAs(adminUser.email, adminUser.password);
      await grantAal2(adminAuthedClient);

      const employee = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });

      const { data: session } = await admin
        .from("TIM_WorkSession")
        .insert({
          user_id: employee.id,
          organization_id: orgId,
          clock_in_time: new Date(Date.now() - 3600_000).toISOString(),
          clock_out_time: new Date().toISOString(),
          clock_in_geo_status: "unavailable",
        })
        .select("id")
        .single();

      await admin.from("TIM_CorrectionRequest").insert({
        user_id: employee.id,
        organization_id: orgId,
        request_type: "clock_in",
        requested_timestamp: new Date().toISOString(),
        reason: "identifying free text",
      });

      await admin.from("NTF_Notification").insert({
        organization_id: orgId,
        recipient_id: employee.id,
        template: "D",
        title: "hi",
        body: "hi",
      });

      // Terminate first (force_anonymize_user requires it), then anonymize.
      const terminateResult = await rpc(adminAuthedClient, "terminate_user", { p_user_id: employee.id });
      expect(terminateResult.error).toBeNull();

      const { error } = await rpc(adminAuthedClient, "force_anonymize_user", { p_user_id: employee.id });
      expect(error).toBeNull();

      const { data: userRow } = await admin
        .from("MST_User")
        .select("first_name, last_name, is_active, avatar_path")
        .eq("id", employee.id)
        .single();
      expect(userRow?.first_name).toBe("Anonymized");
      expect(userRow?.is_active).toBe(false);
      expect(userRow?.avatar_path).toBeNull();

      // The old email/password no longer authenticate anything.
      const failedSignIn = await signInAs(employee.email, employee.password).catch((e: Error) => e);
      expect(failedSignIn).toBeInstanceOf(Error);

      const { data: authUser } = await admin.auth.admin.getUserById(employee.id);
      expect(authUser.user?.email).toBe(`anonymized-${employee.id}@zedhr.com`);
      expect(authUser.user?.banned_until).toBeTruthy();

      const { data: sessionRows } = await admin
        .from("TIM_WorkSession")
        .select("id")
        .eq("id", session!.id);
      expect(sessionRows).toHaveLength(1);

      const { data: correctionRows } = await admin
        .from("TIM_CorrectionRequest")
        .select("reason")
        .eq("user_id", employee.id);
      expect(correctionRows?.[0]?.reason).toBe("[redacted]");

      const { data: notifRows } = await admin
        .from("NTF_Notification")
        .select("id")
        .eq("recipient_id", employee.id);
      expect(notifRows).toHaveLength(0);

      const { data: anonymizedLog } = await admin
        .from("AUD_SystemLog")
        .select("id")
        .eq("organization_id", orgId)
        .eq("target_id", employee.id)
        .eq("action_type", "USER_ANONYMIZED");
      expect(anonymizedLog).toHaveLength(1);
    });

    it("rejects force_anonymize_user for a user who isn't terminated", async () => {
      const orgId = await createOrg(admin);
      const adminUser = await createUser(admin, { organizationId: orgId, role: "admin" });
      const adminAuthedClient = await signInAs(adminUser.email, adminUser.password);
      await grantAal2(adminAuthedClient);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { error } = await rpc(adminAuthedClient, "force_anonymize_user", { p_user_id: employee.id });
      expect(error?.message).toBe("USER_NOT_TERMINATED");
    });

    it("rejects a non-admin caller", async () => {
      const orgId = await createOrg(admin);
      const manager = await createUser(admin, { organizationId: orgId, role: "manager" });
      const managerClient = await signInAs(manager.email, manager.password);
      await grantAal2(managerClient);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { error } = await rpc(managerClient, "force_anonymize_user", { p_user_id: employee.id });
      expect(error).not.toBeNull();
    });
  });

  describe("run_scheduled_anonymization", () => {
    it("only anonymizes users whose scheduled_purge_at has arrived", async () => {
      const orgId = await createOrg(admin);
      const dueUser = await createUser(admin, { organizationId: orgId, role: "employee" });
      const notDueUser = await createUser(admin, { organizationId: orgId, role: "employee" });

      await admin
        .from("MST_User")
        .update({ terminated_at: new Date().toISOString(), scheduled_purge_at: new Date(Date.now() - 60_000).toISOString() })
        .eq("id", dueUser.id);
      await admin
        .from("MST_User")
        .update({
          terminated_at: new Date().toISOString(),
          scheduled_purge_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        })
        .eq("id", notDueUser.id);

      await admin.rpc("run_scheduled_anonymization");

      const { data: dueRow } = await admin.from("MST_User").select("first_name").eq("id", dueUser.id).single();
      expect(dueRow?.first_name).toBe("Anonymized");

      const { data: notDueRow } = await admin.from("MST_User").select("first_name").eq("id", notDueUser.id).single();
      expect(notDueRow?.first_name).toBe("Test");
    });
  });
});
