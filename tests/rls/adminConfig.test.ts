// M7 suite: admin config RPCs (departments, work arrangements, holidays,
// org settings). Same live-Supabase-required, graceful-skip pattern as
// the other tests/rls files.
import { describe, expect, it } from "vitest";
import { adminClient, grantAal2, isSupabaseReachable, rpc, signInAs } from "./client";
import { createOrg, createUser } from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn("\n[tests/rls] Local Supabase isn't reachable — skipping the M7 admin config suite.\n");
}

describe.skipIf(!reachable)("M7 admin config RPCs", () => {
  const admin = adminClient();

  async function freshAdmin(orgId: string) {
    const adminUser = await createUser(admin, { organizationId: orgId, role: "admin" });
    const client = await signInAs(adminUser.email, adminUser.password);
    await grantAal2(client);
    return { adminUser, client };
  }

  describe("departments", () => {
    it("creates and updates a department, auditing both", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);
      const manager = await createUser(admin, { organizationId: orgId, role: "manager" });

      const { data: deptId, error: createError } = await rpc<string>(client, "create_department", {
        p_name: "Engineering",
        p_manager_id: manager.id,
      });
      expect(createError).toBeNull();

      const { data: created } = await admin.from("MST_Department").select("name, manager_id").eq("id", deptId!).single();
      expect(created?.name).toBe("Engineering");
      expect(created?.manager_id).toBe(manager.id);

      const { error: updateError } = await rpc(client, "update_department", {
        p_department_id: deptId,
        p_name: "Platform Engineering",
        p_manager_id: null,
      });
      expect(updateError).toBeNull();

      const { data: updated } = await admin.from("MST_Department").select("name, manager_id").eq("id", deptId!).single();
      expect(updated?.name).toBe("Platform Engineering");
      expect(updated?.manager_id).toBeNull();

      const { data: auditRows } = await admin
        .from("AUD_SystemLog")
        .select("action_type")
        .eq("target_id", deptId!)
        .in("action_type", ["DEPARTMENT_CREATED", "DEPARTMENT_UPDATED"]);
      expect(auditRows).toHaveLength(2);
    });

    it("rejects a manager_id that isn't actually a manager/admin in the org", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { error } = await rpc(client, "create_department", { p_name: "Ops", p_manager_id: employee.id });
      expect(error?.message).toBe("ERR_VALIDATION");
    });

    it("rejects a non-admin caller", async () => {
      const orgId = await createOrg(admin);
      const manager = await createUser(admin, { organizationId: orgId, role: "manager" });
      const managerClient = await signInAs(manager.email, manager.password);
      await grantAal2(managerClient);

      const { error } = await rpc(managerClient, "create_department", { p_name: "Ops" });
      expect(error).not.toBeNull();
    });
  });

  describe("work arrangements", () => {
    it("previews the cascade before and after setting a standing arrangement", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const before = await rpc<string>(client, "preview_work_arrangement", {
        p_user_id: employee.id,
        p_department_id: null,
        p_date: "2026-08-20",
      });
      expect(before.data).toBe("office");

      const { error: setError } = await rpc(client, "set_work_arrangement", {
        p_target_level: "user",
        p_target_id: employee.id,
        p_arrangement: "wfh",
        p_effective_date: "2026-08-01",
        p_expires_date: null,
      });
      expect(setError).toBeNull();

      const after = await rpc<string>(client, "preview_work_arrangement", {
        p_user_id: employee.id,
        p_department_id: null,
        p_date: "2026-08-20",
      });
      expect(after.data).toBe("wfh");
    });

    it("expires a prior standing arrangement when a new one starts, leaving both rows queryable", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      await rpc(client, "set_work_arrangement", {
        p_target_level: "user",
        p_target_id: employee.id,
        p_arrangement: "wfh",
        p_effective_date: "2026-08-01",
        p_expires_date: null,
      });
      await rpc(client, "set_work_arrangement", {
        p_target_level: "user",
        p_target_id: employee.id,
        p_arrangement: "office",
        p_effective_date: "2026-09-01",
        p_expires_date: null,
      });

      const { data: rows } = await admin
        .from("TIM_WorkArrangement")
        .select("arrangement, effective_date, expires_date")
        .eq("target_id", employee.id)
        .order("effective_date");
      expect(rows).toHaveLength(2);
      expect(rows?.[0]).toMatchObject({ arrangement: "wfh", expires_date: "2026-08-31" });
      expect(rows?.[1]).toMatchObject({ arrangement: "office", expires_date: null });
    });

    it("rejects an expires_date before effective_date", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { error } = await rpc(client, "set_work_arrangement", {
        p_target_level: "user",
        p_target_id: employee.id,
        p_arrangement: "wfh",
        p_effective_date: "2026-08-10",
        p_expires_date: "2026-08-01",
      });
      expect(error?.message).toBe("INVALID_TIME_RANGE");
    });
  });

  describe("holidays", () => {
    it("creates and deletes a holiday, auditing both", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);

      const { data: holidayId, error: createError } = await rpc<string>(client, "create_holiday", {
        p_date: "2026-12-25",
        p_name: "Christmas Day",
        p_type: "regular",
      });
      expect(createError).toBeNull();

      const { data: created } = await admin.from("MST_Holiday").select("name").eq("id", holidayId!).single();
      expect(created?.name).toBe("Christmas Day");

      const { error: deleteError } = await rpc(client, "delete_holiday", { p_holiday_id: holidayId });
      expect(deleteError).toBeNull();

      const { data: rows } = await admin.from("MST_Holiday").select("id").eq("id", holidayId!);
      expect(rows).toHaveLength(0);

      const { data: auditRows } = await admin
        .from("AUD_SystemLog")
        .select("action_type")
        .eq("target_id", holidayId!)
        .in("action_type", ["HOLIDAY_CREATED", "HOLIDAY_DELETED"]);
      expect(auditRows).toHaveLength(2);
    });

    it("returns HOLIDAY_NOT_FOUND for an unknown id", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);

      const { error } = await rpc(client, "delete_holiday", {
        p_holiday_id: "00000000-0000-0000-0000-000000000000",
      });
      expect(error?.message).toBe("HOLIDAY_NOT_FOUND");
    });
  });

  describe("org settings", () => {
    it("updates org settings and audits the change", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);

      const { error } = await rpc(client, "update_organization_settings", {
        p_timezone: "Asia/Manila",
        p_display_locale: "en-PH",
        p_pay_cycle_type: "biweekly",
        p_pay_cycle_start_date: "2026-01-01",
        p_geofence_latitude: 14.5995,
        p_geofence_longitude: 120.9842,
        p_geofence_radius_m: 150,
        p_max_cb_minutes: 25,
        p_min_lb_minutes: 45,
        p_data_retention_days: 730,
      });
      expect(error).toBeNull();

      const { data: org } = await admin.from("MST_Organization").select("*").eq("id", orgId).single();
      expect(org?.pay_cycle_type).toBe("biweekly");
      expect(org?.max_cb_minutes).toBe(25);
      expect(org?.min_lb_minutes).toBe(45);
      expect(org?.geofence_radius_m).toBe(150);

      const { data: auditRows } = await admin
        .from("AUD_SystemLog")
        .select("action_type")
        .eq("target_id", orgId)
        .eq("action_type", "ORG_SETTINGS_UPDATED");
      expect(auditRows).toHaveLength(1);
    });

    it("rejects mismatched geofence lat/lng (one set, one null)", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);

      const { error } = await rpc(client, "update_organization_settings", {
        p_timezone: "Asia/Manila",
        p_display_locale: "en-PH",
        p_pay_cycle_type: "monthly",
        p_pay_cycle_start_date: "2026-01-01",
        p_geofence_latitude: 14.5995,
        p_geofence_longitude: null,
        p_max_cb_minutes: 20,
        p_min_lb_minutes: 30,
        p_data_retention_days: 365,
      });
      expect(error?.message).toBe("ERR_VALIDATION");
    });
  });
});
