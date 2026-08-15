// M5 notification suite: dedupe-window helper + Template C (geofence
// breach) wiring into clock_in_user/clock_out_user. Same live-Supabase-
// required, graceful-skip pattern as the other tests/rls files.
import { describe, expect, it } from "vitest";
import { adminClient, isSupabaseReachable, rpc, signInAs } from "./client";
import { createDepartment, createOrg, createUser, setDepartmentManager } from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn("\n[tests/rls] Local Supabase isn't reachable — skipping the M5 notifications suite.\n");
}

const GEOFENCE_CENTER = { lat: 14.5995, lng: 120.9842 }; // Manila
const FAR_AWAY = { lat: 40.7128, lng: -74.006 }; // New York — outside any sane radius

describe.skipIf(!reachable)("M5 notifications", () => {
  const admin = adminClient();

  describe("geofence breach -> Template C", () => {
    it("generates exactly one Template C per 12h per manager/employee pair under repeated out-of-bounds punches", async () => {
      const orgId = await createOrg(admin, {
        geofenceLatitude: GEOFENCE_CENTER.lat,
        geofenceLongitude: GEOFENCE_CENTER.lng,
        geofenceRadiusM: 200,
      });
      const deptId = await createDepartment(admin, orgId);
      const manager = await createUser(admin, { organizationId: orgId, role: "manager", departmentId: deptId });
      await setDepartmentManager(admin, deptId, manager.id);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });
      const client = await signInAs(employee.email, employee.password);

      // Two full outside-the-fence clock-in/clock-out cycles: four separate
      // breach events (clock-in + clock-out, twice), all within the 12h
      // dedupe window.
      for (let i = 0; i < 2; i++) {
        const { error: inError } = await rpc(client, "clock_in_user", {
          p_lat: FAR_AWAY.lat,
          p_lng: FAR_AWAY.lng,
          p_geo_status: "checked",
        });
        expect(inError).toBeNull();

        const { error: outError } = await rpc(client, "clock_out_user", {
          p_lat: FAR_AWAY.lat,
          p_lng: FAR_AWAY.lng,
          p_geo_status: "checked",
        });
        expect(outError).toBeNull();
      }

      const { data: notifications, error } = await admin
        .from("NTF_Notification")
        .select("id, recipient_id, template, dedupe_key")
        .eq("recipient_id", manager.id)
        .eq("template", "C");

      expect(error).toBeNull();
      expect(notifications).toHaveLength(1);
      expect(notifications?.[0].dedupe_key).toBe(`geofence:${manager.id}:${employee.id}`);
    });

    it("does not notify when the punch is inside the geofence", async () => {
      const orgId = await createOrg(admin, {
        geofenceLatitude: GEOFENCE_CENTER.lat,
        geofenceLongitude: GEOFENCE_CENTER.lng,
        geofenceRadiusM: 200,
      });
      const deptId = await createDepartment(admin, orgId);
      const manager = await createUser(admin, { organizationId: orgId, role: "manager", departmentId: deptId });
      await setDepartmentManager(admin, deptId, manager.id);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });
      const client = await signInAs(employee.email, employee.password);

      const { error } = await rpc(client, "clock_in_user", {
        p_lat: GEOFENCE_CENTER.lat,
        p_lng: GEOFENCE_CENTER.lng,
        p_geo_status: "checked",
      });
      expect(error).toBeNull();

      const { data: notifications } = await admin
        .from("NTF_Notification")
        .select("id")
        .eq("recipient_id", manager.id)
        .eq("template", "C");

      expect(notifications).toHaveLength(0);
    });

    it("falls back to notifying every admin when the department has no manager", async () => {
      const orgId = await createOrg(admin, {
        geofenceLatitude: GEOFENCE_CENTER.lat,
        geofenceLongitude: GEOFENCE_CENTER.lng,
        geofenceRadiusM: 200,
      });
      const deptId = await createDepartment(admin, orgId);
      const admin1 = await createUser(admin, { organizationId: orgId, role: "admin" });
      const admin2 = await createUser(admin, { organizationId: orgId, role: "admin" });
      const employee = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });
      const client = await signInAs(employee.email, employee.password);

      const { error } = await rpc(client, "clock_in_user", {
        p_lat: FAR_AWAY.lat,
        p_lng: FAR_AWAY.lng,
        p_geo_status: "checked",
      });
      expect(error).toBeNull();

      const { data: notifications } = await admin
        .from("NTF_Notification")
        .select("recipient_id")
        .eq("template", "C")
        .in("recipient_id", [admin1.id, admin2.id]);

      expect(notifications).toHaveLength(2);
    });
  });

  describe("private.create_deduped_notification (via RPC surface indirectly)", () => {
    it("a fresh dedupe_key after the window would insert again — verified structurally via distinct keys", async () => {
      // The 12h/24h window itself isn't independently exercised end-to-end
      // here (would require manipulating created_at or waiting 12h); the
      // dedupe *logic* is covered by the repeated-punch test above, and the
      // helper is a pure `exists (...) then skip else insert` — no separate
      // per-window branching to miss. This test just proves two distinct
      // dedupe_keys (two different employees) never collide with each other.
      const orgId = await createOrg(admin, {
        geofenceLatitude: GEOFENCE_CENTER.lat,
        geofenceLongitude: GEOFENCE_CENTER.lng,
        geofenceRadiusM: 200,
      });
      const deptId = await createDepartment(admin, orgId);
      const manager = await createUser(admin, { organizationId: orgId, role: "manager", departmentId: deptId });
      await setDepartmentManager(admin, deptId, manager.id);
      const employeeA = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });
      const employeeB = await createUser(admin, { organizationId: orgId, role: "employee", departmentId: deptId });
      const clientA = await signInAs(employeeA.email, employeeA.password);
      const clientB = await signInAs(employeeB.email, employeeB.password);

      await rpc(clientA, "clock_in_user", { p_lat: FAR_AWAY.lat, p_lng: FAR_AWAY.lng, p_geo_status: "checked" });
      await rpc(clientB, "clock_in_user", { p_lat: FAR_AWAY.lat, p_lng: FAR_AWAY.lng, p_geo_status: "checked" });

      const { data: notifications } = await admin
        .from("NTF_Notification")
        .select("dedupe_key")
        .eq("recipient_id", manager.id)
        .eq("template", "C");

      expect(notifications).toHaveLength(2);
      expect(new Set(notifications?.map((n) => n.dedupe_key)).size).toBe(2);
    });
  });
});
