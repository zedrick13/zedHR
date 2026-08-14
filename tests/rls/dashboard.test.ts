// M5 dashboard suite: get_direct_reports_status() scoping (manager
// own-department(s) only, admin org-wide, no cross-department leakage) and
// status/geofence derivation. Same live-Supabase-required, graceful-skip
// pattern as the other tests/rls files.
import { describe, expect, it } from "vitest";
import { adminClient, isSupabaseReachable, rpc, signInAs } from "./client";
import { createDepartment, createOrg, createUser, setDepartmentManager } from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn("\n[tests/rls] Local Supabase isn't reachable — skipping the M5 dashboard suite.\n");
}

const GEOFENCE_CENTER = { lat: 14.5995, lng: 120.9842 }; // Manila
const FAR_AWAY = { lat: 40.7128, lng: -74.006 }; // New York

type DirectReportRow = {
  user_id: string;
  first_name: string;
  last_name: string;
  department_id: string | null;
  department_name: string | null;
  status: string;
  today_seconds: number;
  geofence_state: string | null;
};

describe.skipIf(!reachable)("M5 get_direct_reports_status", () => {
  const admin = adminClient();

  describe("scoping", () => {
    it("a manager sees only their own department's active employees, not another department's", async () => {
      const orgId = await createOrg(admin);
      const deptA = await createDepartment(admin, orgId);
      const deptB = await createDepartment(admin, orgId);
      const managerA = await createUser(admin, { organizationId: orgId, role: "manager", departmentId: deptA });
      await setDepartmentManager(admin, deptA, managerA.id);
      const managerB = await createUser(admin, { organizationId: orgId, role: "manager", departmentId: deptB });
      await setDepartmentManager(admin, deptB, managerB.id);
      const employeeA = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptA });
      await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptB });

      const managerAClient = await signInAs(managerA.email, managerA.password);
      const { data, error } = await rpc<DirectReportRow[]>(managerAClient, "get_direct_reports_status");

      expect(error).toBeNull();
      const ids = data?.map((r) => r.user_id) ?? [];
      expect(ids).toContain(employeeA.id);
      expect(ids).not.toContain(managerB.id);
      expect(ids.length).toBe(1);
    });

    it("a multi-department manager sees the union of both departments, with correct department names", async () => {
      const orgId = await createOrg(admin);
      const deptA = await createDepartment(admin, orgId, "Engineering");
      const deptB = await createDepartment(admin, orgId, "Design");
      const manager = await createUser(admin, { organizationId: orgId, role: "manager", departmentId: deptA });
      await setDepartmentManager(admin, deptA, manager.id);
      await setDepartmentManager(admin, deptB, manager.id);
      const employeeA = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptA });
      const employeeB = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptB });

      const managerClient = await signInAs(manager.email, manager.password);
      const { data, error } = await rpc<DirectReportRow[]>(managerClient, "get_direct_reports_status");

      expect(error).toBeNull();
      const byId = new Map(data?.map((r) => [r.user_id, r]));
      expect(byId.get(employeeA.id)?.department_name).toBe("Engineering");
      expect(byId.get(employeeB.id)?.department_name).toBe("Design");
      expect(new Set(data?.map((r) => r.department_id)).size).toBe(2);
    });

    it("an admin sees every active employee in the org, across departments", async () => {
      const orgId = await createOrg(admin);
      const deptA = await createDepartment(admin, orgId);
      const deptB = await createDepartment(admin, orgId);
      const adminUser = await createUser(admin, { organizationId: orgId, role: "admin" });
      const employeeA = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptA });
      const employeeB = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptB });

      const adminClientLoggedIn = await signInAs(adminUser.email, adminUser.password);
      const { data, error } = await rpc<DirectReportRow[]>(adminClientLoggedIn, "get_direct_reports_status");

      expect(error).toBeNull();
      const ids = data?.map((r) => r.user_id) ?? [];
      expect(ids).toContain(employeeA.id);
      expect(ids).toContain(employeeB.id);
      expect(ids).not.toContain(adminUser.id);
    });

    it("inactive (terminated) employees are excluded", async () => {
      const orgId = await createOrg(admin);
      const deptA = await createDepartment(admin, orgId);
      const manager = await createUser(admin, { organizationId: orgId, role: "manager", departmentId: deptA });
      await setDepartmentManager(admin, deptA, manager.id);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptA });
      await admin.from("MST_User").update({ is_active: false }).eq("id", employee.id);

      const managerClient = await signInAs(manager.email, manager.password);
      const { data } = await rpc<DirectReportRow[]>(managerClient, "get_direct_reports_status");

      expect(data?.map((r) => r.user_id)).not.toContain(employee.id);
    });

    it("an employee cannot call get_direct_reports_status at all", async () => {
      const orgId = await createOrg(admin);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });
      const employeeClient = await signInAs(employee.email, employee.password);

      const { error } = await rpc(employeeClient, "get_direct_reports_status");
      expect(error).not.toBeNull();
      expect(error?.message).toBe("UNAUTHORIZED");
    });
  });

  describe("status + geofence derivation", () => {
    async function setup() {
      const orgId = await createOrg(admin, {
        geofenceLatitude: GEOFENCE_CENTER.lat,
        geofenceLongitude: GEOFENCE_CENTER.lng,
        geofenceRadiusM: 200,
      });
      const deptId = await createDepartment(admin, orgId);
      const manager = await createUser(admin, { organizationId: orgId, role: "manager", departmentId: deptId });
      await setDepartmentManager(admin, deptId, manager.id);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });
      const managerClient = await signInAs(manager.email, manager.password);
      return { orgId, deptId, manager, employee, managerClient };
    }

    async function getRow(managerClient: Awaited<ReturnType<typeof signInAs>>, employeeId: string) {
      const { data } = await rpc<DirectReportRow[]>(managerClient, "get_direct_reports_status");
      return data?.find((r) => r.user_id === employeeId);
    }

    it("no session today: clocked_out with a null geofence_state", async () => {
      const { employee, managerClient } = await setup();
      const row = await getRow(managerClient, employee.id);
      expect(row?.status).toBe("clocked_out");
      expect(row?.geofence_state).toBeNull();
    });

    it("open session inside the geofence: clocked_in / ok", async () => {
      const { orgId, employee, managerClient } = await setup();
      await admin.from("TIM_WorkSession").insert({
        user_id: employee.id,
        organization_id: orgId,
        clock_in_time: new Date().toISOString(),
        clock_in_geo_status: "checked",
        clock_in_lat: GEOFENCE_CENTER.lat,
        clock_in_lng: GEOFENCE_CENTER.lng,
        clock_in_outside_boundary: false,
      });

      const row = await getRow(managerClient, employee.id);
      expect(row?.status).toBe("clocked_in");
      expect(row?.geofence_state).toBe("ok");
    });

    it("open session outside the geofence: out_of_bounds", async () => {
      const { orgId, employee, managerClient } = await setup();
      await admin.from("TIM_WorkSession").insert({
        user_id: employee.id,
        organization_id: orgId,
        clock_in_time: new Date().toISOString(),
        clock_in_geo_status: "checked",
        clock_in_lat: FAR_AWAY.lat,
        clock_in_lng: FAR_AWAY.lng,
        clock_in_outside_boundary: true,
      });

      const row = await getRow(managerClient, employee.id);
      expect(row?.geofence_state).toBe("out_of_bounds");
    });

    it("no GPS fix: no_gps regardless of arrangement", async () => {
      const { orgId, employee, managerClient } = await setup();
      await admin.from("TIM_WorkSession").insert({
        user_id: employee.id,
        organization_id: orgId,
        clock_in_time: new Date().toISOString(),
        clock_in_geo_status: "unavailable",
      });

      const row = await getRow(managerClient, employee.id);
      expect(row?.geofence_state).toBe("no_gps");
    });

    it("wfh arrangement today: N/A (WFH) even with GPS outside the fence", async () => {
      const { orgId, employee, managerClient } = await setup();
      await admin.from("TIM_WorkArrangement").insert({
        organization_id: orgId,
        target_level: "user",
        target_id: employee.id,
        arrangement: "wfh",
        effective_date: new Date().toISOString().slice(0, 10),
      });
      await admin.from("TIM_WorkSession").insert({
        user_id: employee.id,
        organization_id: orgId,
        clock_in_time: new Date().toISOString(),
        clock_in_geo_status: "checked",
        clock_in_lat: FAR_AWAY.lat,
        clock_in_lng: FAR_AWAY.lng,
        clock_in_outside_boundary: false,
      });

      const row = await getRow(managerClient, employee.id);
      expect(row?.geofence_state).toBe("wfh");
    });

    it("an open compensable break: on_cb", async () => {
      const { orgId, employee, managerClient } = await setup();
      const { data: session } = await admin
        .from("TIM_WorkSession")
        .insert({
          user_id: employee.id,
          organization_id: orgId,
          clock_in_time: new Date().toISOString(),
          clock_in_geo_status: "unavailable",
        })
        .select("id")
        .single();
      await admin.from("TIM_CompensableBreak").insert({
        organization_id: orgId,
        work_session_id: session!.id,
        start_time: new Date().toISOString(),
      });

      const row = await getRow(managerClient, employee.id);
      expect(row?.status).toBe("on_cb");
    });

    it("a closed session today: clocked_out with hours counted", async () => {
      const { orgId, employee, managerClient } = await setup();
      const clockIn = new Date(Date.now() - 2 * 3600_000).toISOString();
      const clockOut = new Date().toISOString();
      await admin.from("TIM_WorkSession").insert({
        user_id: employee.id,
        organization_id: orgId,
        clock_in_time: clockIn,
        clock_out_time: clockOut,
        clock_in_geo_status: "unavailable",
      });

      const row = await getRow(managerClient, employee.id);
      expect(row?.status).toBe("clocked_out");
      expect(row?.today_seconds).toBeGreaterThanOrEqual(2 * 3600 - 5);
      expect(row?.today_seconds).toBeLessThanOrEqual(2 * 3600 + 30);
    });
  });
});
