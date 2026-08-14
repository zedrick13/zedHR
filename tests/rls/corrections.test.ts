// M4 corrections workflow suite. Same live-Supabase-required, graceful-skip
// pattern as the other tests/rls files.
import { describe, expect, it } from "vitest";
import { adminClient, grantAal2, isSupabaseReachable, rpc, signInAs } from "./client";
import { createDepartment, createOrg, createUser, createWorkSession, setDepartmentManager } from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn("\n[tests/rls] Local Supabase isn't reachable — skipping the M4 corrections suite.\n");
}

describe.skipIf(!reachable)("M4 corrections workflow", () => {
  const admin = adminClient();

  // approve_correction_request/reject_correction_request/admin_edit_locked_timecard
  // are all aal2-gated (SPEC §3.2 "MFA gate") — every manager/admin actor in
  // this suite needs a real TOTP grant, not just the role.
  async function managedEmployeeSetup() {
    const orgId = await createOrg(admin);
    const deptId = await createDepartment(admin, orgId);
    const manager = await createUser(admin, { organizationId: orgId, role: "manager", departmentId: deptId });
    await setDepartmentManager(admin, deptId, manager.id);
    const employee = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });
    const sessionId = await createWorkSession(admin, { userId: employee.id, organizationId: orgId });

    const managerClient = await signInAs(manager.email, manager.password);
    await grantAal2(managerClient);
    const employeeClient = await signInAs(employee.email, employee.password);
    return { orgId, deptId, manager, employee, sessionId, managerClient, employeeClient };
  }

  describe("submit_correction_request", () => {
    it("validates reason length", async () => {
      const { employeeClient, sessionId } = await managedEmployeeSetup();
      const tooLong = await rpc(employeeClient, "submit_correction_request", {
        p_work_session_id: sessionId,
        p_request_type: "clock_in",
        p_requested_timestamp: new Date().toISOString(),
        p_reason: "x".repeat(501),
      });
      expect(tooLong.error?.message).toBe("ERR_VALIDATION");

      const empty = await rpc(employeeClient, "submit_correction_request", {
        p_work_session_id: sessionId,
        p_request_type: "clock_in",
        p_requested_timestamp: new Date().toISOString(),
        p_reason: "",
      });
      expect(empty.error?.message).toBe("ERR_VALIDATION");
    });

    it("create_session must not reference an existing session", async () => {
      const { employeeClient, sessionId } = await managedEmployeeSetup();
      const { error } = await rpc(employeeClient, "submit_correction_request", {
        p_work_session_id: sessionId,
        p_request_type: "create_session",
        p_requested_timestamp: new Date().toISOString(),
        p_reason: "Forgot to clock in entirely",
      });
      expect(error?.message).toBe("ERR_VALIDATION");
    });

    it("succeeds for a valid clock_in correction on the employee's own session", async () => {
      const { employeeClient, sessionId } = await managedEmployeeSetup();
      const { data, error } = await rpc<string>(employeeClient, "submit_correction_request", {
        p_work_session_id: sessionId,
        p_request_type: "clock_in",
        p_requested_timestamp: new Date().toISOString(),
        p_reason: "Clocked in late due to traffic, actual start was earlier",
      });
      expect(error).toBeNull();
      expect(data).toBeTruthy();
    });
  });

  describe("approve_correction_request", () => {
    it("manager in the employee's department can approve; applies the correction", async () => {
      const { managerClient, employeeClient, sessionId } = await managedEmployeeSetup();
      const newClockIn = new Date(Date.now() - 3600_000).toISOString();

      const { data: correctionId } = await rpc<string>(employeeClient, "submit_correction_request", {
        p_work_session_id: sessionId,
        p_request_type: "clock_in",
        p_requested_timestamp: newClockIn,
        p_reason: "Actual clock-in time was an hour earlier",
      });

      const { error } = await rpc(managerClient, "approve_correction_request", {
        p_correction_id: correctionId,
      });
      expect(error).toBeNull();

      const { data: session } = await admin
        .from("TIM_WorkSession")
        .select("clock_in_time")
        .eq("id", sessionId)
        .single();
      expect(new Date(session!.clock_in_time).toISOString()).toBe(newClockIn);

      const { data: correction } = await admin
        .from("TIM_CorrectionRequest")
        .select("status, reviewed_by")
        .eq("id", correctionId!)
        .single();
      expect(correction?.status).toBe("approved");
    });

    it("a manager outside the employee's department is rejected", async () => {
      const { orgId, employeeClient, sessionId } = await managedEmployeeSetup();
      const otherDeptId = await createDepartment(admin, orgId);
      const otherManager = await createUser(admin, {
        organizationId: orgId,
        role: "manager",
        departmentId: otherDeptId,
      });
      await setDepartmentManager(admin, otherDeptId, otherManager.id);
      const otherManagerClient = await signInAs(otherManager.email, otherManager.password);
      await grantAal2(otherManagerClient);

      const { data: correctionId } = await rpc<string>(employeeClient, "submit_correction_request", {
        p_work_session_id: sessionId,
        p_request_type: "clock_in",
        p_requested_timestamp: new Date().toISOString(),
        p_reason: "Some correction reason text",
      });

      const { error } = await rpc(otherManagerClient, "approve_correction_request", {
        p_correction_id: correctionId,
      });
      expect(error?.message).toBe("UNAUTHORIZED");
    });

    it("concurrent double-approve: exactly one succeeds, the other is CORRECTION_ALREADY_RESOLVED", async () => {
      const { orgId, employeeClient, sessionId } = await managedEmployeeSetup();
      // Two distinct admin reviewers race the same approval (manager_id is
      // a single column, so two *managers* can't both own the department —
      // admin authorization doesn't depend on department, so it's the
      // cleaner way to get two independent reviewers).
      const admin1 = await createUser(admin, { organizationId: orgId, role: "admin" });
      const admin2 = await createUser(admin, { organizationId: orgId, role: "admin" });
      const admin1Client = await signInAs(admin1.email, admin1.password);
      const admin2Client = await signInAs(admin2.email, admin2.password);
      await grantAal2(admin1Client);
      await grantAal2(admin2Client);

      const { data: correctionId } = await rpc<string>(employeeClient, "submit_correction_request", {
        p_work_session_id: sessionId,
        p_request_type: "clock_in",
        p_requested_timestamp: new Date().toISOString(),
        p_reason: "Racing this approval on purpose for the test",
      });

      const [r1, r2] = await Promise.all([
        rpc(admin1Client, "approve_correction_request", { p_correction_id: correctionId }),
        rpc(admin2Client, "approve_correction_request", { p_correction_id: correctionId }),
      ]);

      const errors = [r1.error, r2.error].filter((e) => e !== null);
      const successes = [r1.error, r2.error].filter((e) => e === null);
      expect(successes).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("CORRECTION_ALREADY_RESOLVED");
    });

    it("create_session correction creates a new session and links work_session_id back", async () => {
      const { orgId, deptId, managerClient } = await managedEmployeeSetup();
      const employee2 = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });
      const employee2Client = await signInAs(employee2.email, employee2.password);

      const clockInTime = new Date(Date.now() - 8 * 3600_000).toISOString();
      const { data: correctionId } = await rpc<string>(employee2Client, "submit_correction_request", {
        p_work_session_id: null,
        p_request_type: "create_session",
        p_requested_timestamp: clockInTime,
        p_reason: "Forgot to clock in this entire missing shift",
      });

      const { error } = await rpc(managerClient, "approve_correction_request", {
        p_correction_id: correctionId,
      });
      expect(error).toBeNull();

      const { data: correction } = await admin
        .from("TIM_CorrectionRequest")
        .select("work_session_id")
        .eq("id", correctionId!)
        .single();
      expect(correction?.work_session_id).toBeTruthy();

      const { data: session } = await admin
        .from("TIM_WorkSession")
        .select("clock_in_time, clock_out_time")
        .eq("id", correction!.work_session_id!)
        .single();
      expect(new Date(session!.clock_in_time).toISOString()).toBe(clockInTime);
      expect(session?.clock_out_time).toBeNull();
    });
  });

  describe("reject_correction_request", () => {
    it("rejects, stores the note, and never touches the original session", async () => {
      const { managerClient, employeeClient, sessionId } = await managedEmployeeSetup();
      const { data: originalSession } = await admin
        .from("TIM_WorkSession")
        .select("clock_in_time")
        .eq("id", sessionId)
        .single();

      const { data: correctionId } = await rpc<string>(employeeClient, "submit_correction_request", {
        p_work_session_id: sessionId,
        p_request_type: "clock_in",
        p_requested_timestamp: new Date(Date.now() - 999_000).toISOString(),
        p_reason: "This correction should get rejected in the test",
      });

      const { error } = await rpc(managerClient, "reject_correction_request", {
        p_correction_id: correctionId,
        p_rejection_note: "Doesn't match the door-badge log",
      });
      expect(error).toBeNull();

      const { data: correction } = await admin
        .from("TIM_CorrectionRequest")
        .select("status, rejection_note")
        .eq("id", correctionId!)
        .single();
      expect(correction?.status).toBe("rejected");
      expect(correction?.rejection_note).toBe("Doesn't match the door-badge log");

      const { data: sessionAfter } = await admin
        .from("TIM_WorkSession")
        .select("clock_in_time")
        .eq("id", sessionId)
        .single();
      expect(sessionAfter?.clock_in_time).toBe(originalSession?.clock_in_time);
    });
  });

  describe("admin_edit_locked_timecard", () => {
    it("requires a reason", async () => {
      const orgId = await createOrg(admin);
      const adminUser = await createUser(admin, { organizationId: orgId, role: "admin" });
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });
      const sessionId = await createWorkSession(admin, { userId: employee.id, organizationId: orgId });
      const adminClientAuthed = await signInAs(adminUser.email, adminUser.password);
      await grantAal2(adminClientAuthed);

      const { error } = await rpc(adminClientAuthed, "admin_edit_locked_timecard", {
        p_session_id: sessionId,
        p_clock_in: new Date().toISOString(),
        p_clock_out: null,
        p_reason: "",
      });
      expect(error?.message).toBe("EDIT_REASON_REQUIRED");
    });

    it("rejects an invalid time range", async () => {
      const orgId = await createOrg(admin);
      const adminUser = await createUser(admin, { organizationId: orgId, role: "admin" });
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });
      const sessionId = await createWorkSession(admin, { userId: employee.id, organizationId: orgId });
      const adminClientAuthed = await signInAs(adminUser.email, adminUser.password);
      await grantAal2(adminClientAuthed);

      const clockIn = new Date();
      const clockOut = new Date(clockIn.getTime() - 60_000); // before clock-in

      const { error } = await rpc(adminClientAuthed, "admin_edit_locked_timecard", {
        p_session_id: sessionId,
        p_clock_in: clockIn.toISOString(),
        p_clock_out: clockOut.toISOString(),
        p_reason: "Testing invalid range",
      });
      expect(error?.message).toBe("INVALID_TIME_RANGE");
    });

    it("succeeds and directly updates the session", async () => {
      const orgId = await createOrg(admin);
      const adminUser = await createUser(admin, { organizationId: orgId, role: "admin" });
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });
      const sessionId = await createWorkSession(admin, { userId: employee.id, organizationId: orgId });
      const adminClientAuthed = await signInAs(adminUser.email, adminUser.password);
      await grantAal2(adminClientAuthed);

      const clockIn = new Date(Date.now() - 8 * 3600_000);
      const clockOut = new Date();

      const { error } = await rpc(adminClientAuthed, "admin_edit_locked_timecard", {
        p_session_id: sessionId,
        p_clock_in: clockIn.toISOString(),
        p_clock_out: clockOut.toISOString(),
        p_reason: "Employee forgot to clock out, verified with manager",
      });
      expect(error).toBeNull();

      const { data: session } = await admin
        .from("TIM_WorkSession")
        .select("clock_in_time, clock_out_time")
        .eq("id", sessionId)
        .single();
      expect(new Date(session!.clock_in_time).toISOString()).toBe(clockIn.toISOString());
      expect(new Date(session!.clock_out_time!).toISOString()).toBe(clockOut.toISOString());
    });

    it("rejects a non-admin caller", async () => {
      const orgId = await createOrg(admin);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });
      const sessionId = await createWorkSession(admin, { userId: employee.id, organizationId: orgId });
      const employeeClient = await signInAs(employee.email, employee.password);

      const { error } = await rpc(employeeClient, "admin_edit_locked_timecard", {
        p_session_id: sessionId,
        p_clock_in: new Date().toISOString(),
        p_clock_out: null,
        p_reason: "Trying to self-edit",
      });
      expect(error?.message).toBe("UNAUTHORIZED");
    });
  });
});
