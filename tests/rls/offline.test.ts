// M6 offline sync suite: discounted-drift logging (SPEC §8.1) and
// log_sync_conflict (Template F + TIM_SyncConflict + audit). Same
// live-Supabase-required, graceful-skip pattern as the other tests/rls
// files. The idempotent-retry / backoff / continue-past-failure behavior
// itself is a client-only concern, covered by tests/offline/syncWorker.test.ts.
import { describe, expect, it } from "vitest";
import { adminClient, isSupabaseReachable, rpc, signInAs } from "./client";
import { createDepartment, createOrg, createUser, setDepartmentManager } from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn("\n[tests/rls] Local Supabase isn't reachable — skipping the M6 offline suite.\n");
}

type AuditRow = { action_type: string; new_value: Record<string, unknown> | null };

describe.skipIf(!reachable)("M6 offline sync", () => {
  const admin = adminClient();

  async function freshEmployee() {
    const orgId = await createOrg(admin);
    const deptId = await createDepartment(admin, orgId);
    const managerUser = await createUser(admin, { organizationId: orgId, role: "manager", departmentId: deptId });
    await setDepartmentManager(admin, deptId, managerUser.id);
    const employee = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });
    const client = await signInAs(employee.email, employee.password);
    return { orgId, deptId, managerUser, employee, client };
  }

  async function latestAuditRowFor(orgId: string, actorId: string, actionType: string): Promise<AuditRow | undefined> {
    // AUD_SystemLog reads are role-scoped but not aal2-gated (CLAUDE.md
    // invariant #6: "MFA gates manager/admin WRITES only") — no grantAal2 needed.
    const adminUser = await createUser(admin, { organizationId: orgId, role: "admin" });
    const adminAuthedClient = await signInAs(adminUser.email, adminUser.password);
    const { data } = await adminAuthedClient
      .from("AUD_SystemLog")
      .select("action_type, new_value")
      .eq("organization_id", orgId)
      .eq("actor_id", actorId)
      .eq("action_type", actionType)
      .order("created_at", { ascending: false })
      .limit(1);
    return (data?.[0] as AuditRow | undefined) ?? undefined;
  }

  describe("discounted drift check", () => {
    it("logs SUSPICIOUS_DRIFT_DETECTED when the discounted drift exceeds 5 minutes", async () => {
      const { orgId, employee, client } = await freshEmployee();

      // Client clock claims the punch was attempted 20 minutes ago, but
      // reports only 5 minutes of that as offline time — 15 minutes of
      // unexplained drift, well past the 5:00 threshold.
      const attemptedTimestamp = new Date(Date.now() - 20 * 60_000).toISOString();
      const { error } = await rpc(client, "clock_in_user", {
        p_lat: null,
        p_lng: null,
        p_geo_status: "unavailable",
        p_attempted_timestamp: attemptedTimestamp,
        p_offline_duration_seconds: 5 * 60,
      });
      expect(error).toBeNull();

      const row = await latestAuditRowFor(orgId, employee.id, "SUSPICIOUS_DRIFT_DETECTED");
      expect(row).toBeDefined();
      expect(row?.new_value?.action).toBe("clock_in");
    });

    it("does not log when the discounted drift is within tolerance", async () => {
      const { orgId, employee, client } = await freshEmployee();

      // Attempted 5 minutes ago, offline for close to that whole 5
      // minutes — discounted drift is small (well under 5:00).
      const attemptedTimestamp = new Date(Date.now() - 5 * 60_000).toISOString();
      const { error } = await rpc(client, "clock_in_user", {
        p_lat: null,
        p_lng: null,
        p_geo_status: "unavailable",
        p_attempted_timestamp: attemptedTimestamp,
        p_offline_duration_seconds: 5 * 60 - 10,
      });
      expect(error).toBeNull();

      const row = await latestAuditRowFor(orgId, employee.id, "SUSPICIOUS_DRIFT_DETECTED");
      expect(row).toBeUndefined();
    });

    it("skips the drift check entirely on a live (non-offline) call", async () => {
      const { orgId, employee, client } = await freshEmployee();

      const { error } = await rpc(client, "clock_in_user", {
        p_lat: null,
        p_lng: null,
        p_geo_status: "unavailable",
      });
      expect(error).toBeNull();

      const row = await latestAuditRowFor(orgId, employee.id, "SUSPICIOUS_DRIFT_DETECTED");
      expect(row).toBeUndefined();
    });
  });

  describe("log_sync_conflict", () => {
    it("records a TIM_SyncConflict row, notifies the manager (Template F), and audits it", async () => {
      const { orgId, managerUser, employee, client } = await freshEmployee();

      const { data: conflictId, error } = await rpc<string>(client, "log_sync_conflict", {
        p_failed_action: "clock_in",
        p_details: { error_code: "ERR_VALIDATION" },
      });
      expect(error).toBeNull();
      expect(conflictId).toBeTruthy();

      const { data: conflictRow } = await admin
        .from("TIM_SyncConflict")
        .select("failed_action, user_id, organization_id")
        .eq("id", conflictId!)
        .single();
      expect(conflictRow?.failed_action).toBe("clock_in");
      expect(conflictRow?.user_id).toBe(employee.id);

      const { data: notifications } = await admin
        .from("NTF_Notification")
        .select("template, recipient_id")
        .eq("recipient_id", managerUser.id)
        .eq("template", "F");
      expect(notifications).toHaveLength(1);

      const auditRow = await latestAuditRowFor(orgId, employee.id, "SYNC_CONFLICT_LOGGED");
      expect(auditRow).toBeDefined();
    });

    it("rejects an unrecognized failed_action", async () => {
      const { client } = await freshEmployee();

      const { error } = await rpc(client, "log_sync_conflict", {
        p_failed_action: "delete_everything",
        p_details: {},
      });
      expect(error?.message).toBe("ERR_VALIDATION");
    });

    it("falls back to notifying every admin when the department has no manager", async () => {
      const orgId = await createOrg(admin);
      const deptId = await createDepartment(admin, orgId);
      const admin1 = await createUser(admin, { organizationId: orgId, role: "admin" });
      const employee = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });
      const client = await signInAs(employee.email, employee.password);

      const { error } = await rpc(client, "log_sync_conflict", {
        p_failed_action: "end_lb",
        p_details: {},
      });
      expect(error).toBeNull();

      const { data: notifications } = await admin
        .from("NTF_Notification")
        .select("recipient_id")
        .eq("template", "F")
        .eq("recipient_id", admin1.id);
      expect(notifications).toHaveLength(1);
    });
  });
});
