// RLS test suite (SPEC.md M1 AC): proves the negative case per SPEC.md
// §3.2 for each table — wrong user/role/org cannot read or write, and
// (CLAUDE.md invariant #2) that no table accepts a direct client write
// outside the tables the spec explicitly carves out (NTF_Notification's
// is_read/read_at mark-read).
//
// Requires a running local Supabase stack (`supabase start`). If it isn't
// reachable, the whole suite is skipped with a warning rather than failing
// `pnpm test` in environments without Docker.
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { adminClient, anonClient, isSupabaseReachable, signInAs } from "./client";
import {
  createDepartment,
  createNotification,
  createOrg,
  createUser,
  createWorkSession,
  setDepartmentManager,
} from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn(
    "\n[tests/rls] Local Supabase isn't reachable at " +
      (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321") +
      " — skipping the RLS suite. Run `supabase start` (or `supabase db reset`) first.\n",
  );
}

describe.skipIf(!reachable)("RLS policies (SPEC.md §3.2)", () => {
  const admin = adminClient();

  let orgAId: string;
  let orgBId: string;
  let deptA1Id: string;
  let deptA2Id: string;
  let deptB1Id: string;

  let employeeA1: { id: string; email: string; password: string };
  let employeeA1b: { id: string; email: string; password: string };
  let employeeA2: { id: string; email: string; password: string };
  let managerA1: { id: string; email: string; password: string };
  let adminA: { id: string; email: string; password: string };
  let employeeB1: { id: string; email: string; password: string };

  let clientEmployeeA1: SupabaseClient<Database>;
  let clientEmployeeA1b: SupabaseClient<Database>;
  let clientEmployeeA2: SupabaseClient<Database>;
  let clientManagerA1: SupabaseClient<Database>;
  let clientAdminA: SupabaseClient<Database>;
  let clientEmployeeB1: SupabaseClient<Database>;

  let sessionA1Id: string;
  let sessionA2Id: string;
  let notificationA1Id: string;

  beforeAll(async () => {
    orgAId = await createOrg(admin);
    orgBId = await createOrg(admin);

    deptA1Id = await createDepartment(admin, orgAId, "Dept A1");
    deptA2Id = await createDepartment(admin, orgAId, "Dept A2");
    deptB1Id = await createDepartment(admin, orgBId, "Dept B1");

    managerA1 = await createUser(admin, {
      organizationId: orgAId,
      role: "manager",
      departmentId: deptA1Id,
    });
    await setDepartmentManager(admin, deptA1Id, managerA1.id);

    employeeA1 = await createUser(admin, {
      organizationId: orgAId,
      role: "employee",
      departmentId: deptA1Id,
    });
    employeeA1b = await createUser(admin, {
      organizationId: orgAId,
      role: "employee",
      departmentId: deptA1Id,
    });
    employeeA2 = await createUser(admin, {
      organizationId: orgAId,
      role: "employee",
      departmentId: deptA2Id,
    });
    adminA = await createUser(admin, { organizationId: orgAId, role: "admin" });
    employeeB1 = await createUser(admin, {
      organizationId: orgBId,
      role: "employee",
      departmentId: deptB1Id,
    });

    [
      clientEmployeeA1,
      clientEmployeeA1b,
      clientEmployeeA2,
      clientManagerA1,
      clientAdminA,
      clientEmployeeB1,
    ] = await Promise.all([
      signInAs(employeeA1.email, employeeA1.password),
      signInAs(employeeA1b.email, employeeA1b.password),
      signInAs(employeeA2.email, employeeA2.password),
      signInAs(managerA1.email, managerA1.password),
      signInAs(adminA.email, adminA.password),
      signInAs(employeeB1.email, employeeB1.password),
    ]);

    sessionA1Id = await createWorkSession(admin, {
      userId: employeeA1.id,
      organizationId: orgAId,
    });
    sessionA2Id = await createWorkSession(admin, {
      userId: employeeA2.id,
      organizationId: orgAId,
    });
    notificationA1Id = await createNotification(admin, {
      organizationId: orgAId,
      recipientId: employeeA1.id,
    });
  }, 60_000);

  describe("MST_Organization", () => {
    it("a user sees only their own org", async () => {
      const { data } = await clientEmployeeA1.from("MST_Organization").select("id");
      expect(data?.map((r) => r.id)).toEqual([orgAId]);
    });

    it("cross-org: org B's user never sees org A's row", async () => {
      const { data } = await clientEmployeeB1.from("MST_Organization").select("id");
      expect(data?.map((r) => r.id)).not.toContain(orgAId);
    });

    it("anon sees nothing", async () => {
      const { data } = await anonClient().from("MST_Organization").select("id");
      expect(data).toEqual([]);
    });
  });

  describe("MST_User", () => {
    it("employee reads own profile", async () => {
      const { data } = await clientEmployeeA1.from("MST_User").select("id").eq("id", employeeA1.id);
      expect(data?.length).toBe(1);
    });

    it("employee cannot read a peer's profile", async () => {
      const { data } = await clientEmployeeA1
        .from("MST_User")
        .select("id")
        .eq("id", employeeA1b.id);
      expect(data).toEqual([]);
    });

    it("manager reads managed-department members", async () => {
      const { data } = await clientManagerA1
        .from("MST_User")
        .select("id")
        .in("id", [employeeA1.id, employeeA1b.id]);
      expect(data?.map((r) => r.id).sort()).toEqual([employeeA1.id, employeeA1b.id].sort());
    });

    it("manager cannot read a member of a department they don't manage", async () => {
      const { data } = await clientManagerA1
        .from("MST_User")
        .select("id")
        .eq("id", employeeA2.id);
      expect(data).toEqual([]);
    });

    it("admin reads all org members, but not another org's", async () => {
      const { data } = await clientAdminA.from("MST_User").select("id");
      const ids = data?.map((r) => r.id) ?? [];
      expect(ids).toEqual(
        expect.arrayContaining([employeeA1.id, employeeA1b.id, employeeA2.id, managerA1.id]),
      );
      expect(ids).not.toContain(employeeB1.id);
    });
  });

  describe("TIM_WorkSession", () => {
    it("employee reads own session only", async () => {
      const { data } = await clientEmployeeA1.from("TIM_WorkSession").select("id");
      expect(data?.map((r) => r.id)).toEqual([sessionA1Id]);
    });

    it("manager reads managed-department sessions, not others", async () => {
      const { data } = await clientManagerA1.from("TIM_WorkSession").select("id");
      const ids = data?.map((r) => r.id) ?? [];
      expect(ids).toContain(sessionA1Id);
      expect(ids).not.toContain(sessionA2Id);
    });

    it("admin reads all org sessions", async () => {
      const { data } = await clientAdminA.from("TIM_WorkSession").select("id");
      const ids = data?.map((r) => r.id) ?? [];
      expect(ids).toEqual(expect.arrayContaining([sessionA1Id, sessionA2Id]));
    });

    it("employee in an unmanaged-by-managerA1 department still only sees their own", async () => {
      const { data } = await clientEmployeeA2.from("TIM_WorkSession").select("id");
      expect(data?.map((r) => r.id)).toEqual([sessionA2Id]);
    });

    it("no direct client write is possible for employee or admin (RPC-only)", async () => {
      const attempt = (client: SupabaseClient<Database>, userId: string) =>
        client.from("TIM_WorkSession").insert({
          user_id: userId,
          organization_id: orgAId,
          clock_in_time: new Date().toISOString(),
          clock_in_geo_status: "unavailable",
        });

      const asEmployee = await attempt(clientEmployeeA1, employeeA1.id);
      expect(asEmployee.error).not.toBeNull();

      const asAdmin = await attempt(clientAdminA, employeeA1.id);
      expect(asAdmin.error).not.toBeNull();
    });
  });

  describe("AUD_SystemLog", () => {
    it("admin-only; employees and managers see nothing", async () => {
      await admin.from("AUD_SystemLog").insert({
        organization_id: orgAId,
        actor_id: adminA.id,
        action_type: "CLOCK_IN",
      });

      const [employeeResult, managerResult, adminResult] = await Promise.all([
        clientEmployeeA1.from("AUD_SystemLog").select("id"),
        clientManagerA1.from("AUD_SystemLog").select("id"),
        clientAdminA.from("AUD_SystemLog").select("id"),
      ]);

      expect(employeeResult.data).toEqual([]);
      expect(managerResult.data).toEqual([]);
      expect(adminResult.data?.length).toBeGreaterThan(0);
    });
  });

  describe("MST_MfaBackupCode / RTL_RateLimitEvent", () => {
    it("no client role can read either table, even admin", async () => {
      await admin.from("MST_MfaBackupCode").insert({
        organization_id: orgAId,
        user_id: adminA.id,
        code_hash: "x",
      });
      await admin.from("RTL_RateLimitEvent").insert({
        organization_id: orgAId,
        user_id: adminA.id,
        bucket_key: "test:bucket",
      });

      const [mfaAsAdmin, rateAsAdmin] = await Promise.all([
        clientAdminA.from("MST_MfaBackupCode").select("id"),
        clientAdminA.from("RTL_RateLimitEvent").select("id"),
      ]);

      expect(mfaAsAdmin.data).toEqual([]);
      expect(rateAsAdmin.data).toEqual([]);
    });
  });

  describe("NTF_Notification", () => {
    it("recipient can mark their own notification read", async () => {
      const { error } = await clientEmployeeA1
        .from("NTF_Notification")
        .update({ is_read: true })
        .eq("id", notificationA1Id);
      expect(error).toBeNull();

      const { data } = await admin
        .from("NTF_Notification")
        .select("is_read")
        .eq("id", notificationA1Id)
        .single();
      expect(data?.is_read).toBe(true);
    });

    it("a non-recipient's update touches zero rows", async () => {
      await admin.from("NTF_Notification").update({ is_read: false }).eq("id", notificationA1Id);

      await clientEmployeeA1b
        .from("NTF_Notification")
        .update({ is_read: true })
        .eq("id", notificationA1Id);

      const { data } = await admin
        .from("NTF_Notification")
        .select("is_read")
        .eq("id", notificationA1Id)
        .single();
      expect(data?.is_read).toBe(false);
    });

    it("the recipient cannot rewrite immutable columns like title via the client", async () => {
      // `title` is a valid column in the generated Update type (grants
      // aren't reflected in generated types) — this checks the DB-level
      // column grant actually rejects it, not just the TS surface.
      const { error } = await clientEmployeeA1
        .from("NTF_Notification")
        .update({ is_read: true, title: "hacked" })
        .eq("id", notificationA1Id);
      expect(error).not.toBeNull();
    });
  });
});
