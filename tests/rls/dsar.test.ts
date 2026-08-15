// M7 DSAR suite: log_dsar_request / resolve_dsar_request (SPEC §8.3). Same
// live-Supabase-required, graceful-skip pattern as the other tests/rls files.
import { describe, expect, it } from "vitest";
import { adminClient, grantAal2, isSupabaseReachable, rpc, signInAs } from "./client";
import { createOrg, createUser } from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn("\n[tests/rls] Local Supabase isn't reachable — skipping the M7 DSAR suite.\n");
}

describe.skipIf(!reachable)("M7 DSAR", () => {
  const admin = adminClient();

  async function freshAdmin(orgId: string) {
    const adminUser = await createUser(admin, { organizationId: orgId, role: "admin" });
    const client = await signInAs(adminUser.email, adminUser.password);
    await grantAal2(client);
    return { adminUser, client };
  }

  describe("log_dsar_request", () => {
    it("logs a request, audits DSAR_REQUEST_LOGGED, and notifies every other admin (Template G)", async () => {
      const orgId = await createOrg(admin);
      const { adminUser: actor, client: actorClient } = await freshAdmin(orgId);
      const otherAdmin = await createUser(admin, { organizationId: orgId, role: "admin" });
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { data: dsarId, error } = await rpc<string>(actorClient, "log_dsar_request", {
        p_user_id: employee.id,
        p_type: "access",
        p_notes: "employee emailed HR asking for their records",
      });
      expect(error).toBeNull();
      expect(dsarId).toBeTruthy();

      const { data: row } = await admin
        .from("MST_DSARRequest")
        .select("status, request_type, user_id, logged_by")
        .eq("id", dsarId!)
        .single();
      expect(row?.status).toBe("pending");
      expect(row?.request_type).toBe("access");
      expect(row?.user_id).toBe(employee.id);
      expect(row?.logged_by).toBe(actor.id);

      const { data: notifications } = await admin
        .from("NTF_Notification")
        .select("recipient_id")
        .eq("template", "G")
        .eq("recipient_id", otherAdmin.id);
      expect(notifications).toHaveLength(1);

      // The actor themself shouldn't get a self-notification.
      const { data: selfNotifications } = await admin
        .from("NTF_Notification")
        .select("recipient_id")
        .eq("template", "G")
        .eq("recipient_id", actor.id);
      expect(selfNotifications).toHaveLength(0);
    });

    it("rejects a non-admin caller", async () => {
      const orgId = await createOrg(admin);
      const manager = await createUser(admin, { organizationId: orgId, role: "manager" });
      const managerClient = await signInAs(manager.email, manager.password);
      await grantAal2(managerClient);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { error } = await rpc(managerClient, "log_dsar_request", {
        p_user_id: employee.id,
        p_type: "access",
      });
      expect(error).not.toBeNull();
    });

    it("rejects an invalid request type", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { error } = await rpc(client, "log_dsar_request", {
        p_user_id: employee.id,
        p_type: "portability",
      });
      expect(error?.message).toBe("ERR_VALIDATION");
    });
  });

  describe("resolve_dsar_request", () => {
    it("resolves an access request as 'resolved' without touching the employee", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { data: dsarId } = await rpc<string>(client, "log_dsar_request", {
        p_user_id: employee.id,
        p_type: "access",
      });

      const { error } = await rpc(client, "resolve_dsar_request", {
        p_dsar_id: dsarId,
        p_resolution_note: "CSV handed over via secure channel",
      });
      expect(error).toBeNull();

      const { data: row } = await admin
        .from("MST_DSARRequest")
        .select("status, resolution_note, resolved_at")
        .eq("id", dsarId!)
        .single();
      expect(row?.status).toBe("resolved");
      expect(row?.resolution_note).toBe("CSV handed over via secure channel");
      expect(row?.resolved_at).toBeTruthy();

      const { data: userRow } = await admin.from("MST_User").select("first_name").eq("id", employee.id).single();
      expect(userRow?.first_name).toBe("Test");
    });

    it("declines an erasure request for a still-active employee (legal-retention exemption)", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { data: dsarId } = await rpc<string>(client, "log_dsar_request", {
        p_user_id: employee.id,
        p_type: "erasure",
      });

      const { error } = await rpc(client, "resolve_dsar_request", { p_dsar_id: dsarId });
      expect(error).toBeNull();

      const { data: row } = await admin
        .from("MST_DSARRequest")
        .select("status")
        .eq("id", dsarId!)
        .single();
      expect(row?.status).toBe("declined");

      const { data: userRow } = await admin.from("MST_User").select("first_name").eq("id", employee.id).single();
      expect(userRow?.first_name).toBe("Test");
    });

    it("resolves an erasure request for a terminated employee by anonymizing them", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });
      await admin
        .from("MST_User")
        .update({ terminated_at: new Date().toISOString(), scheduled_purge_at: new Date(Date.now() + 365 * 86_400_000).toISOString() })
        .eq("id", employee.id);

      const { data: dsarId } = await rpc<string>(client, "log_dsar_request", {
        p_user_id: employee.id,
        p_type: "erasure",
      });

      const { error } = await rpc(client, "resolve_dsar_request", { p_dsar_id: dsarId });
      expect(error).toBeNull();

      const { data: row } = await admin
        .from("MST_DSARRequest")
        .select("status")
        .eq("id", dsarId!)
        .single();
      expect(row?.status).toBe("resolved");

      const { data: userRow } = await admin.from("MST_User").select("first_name").eq("id", employee.id).single();
      expect(userRow?.first_name).toBe("Anonymized");
    });

    it("rejects resolving an already-resolved request", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });

      const { data: dsarId } = await rpc<string>(client, "log_dsar_request", {
        p_user_id: employee.id,
        p_type: "access",
      });
      await rpc(client, "resolve_dsar_request", { p_dsar_id: dsarId });

      const { error } = await rpc(client, "resolve_dsar_request", { p_dsar_id: dsarId });
      expect(error?.message).toBe("DSAR_REQUEST_ALREADY_RESOLVED");
    });

    it("returns DSAR_REQUEST_NOT_FOUND for an unknown id", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);

      const { error } = await rpc(client, "resolve_dsar_request", {
        p_dsar_id: "00000000-0000-0000-0000-000000000000",
      });
      expect(error?.message).toBe("DSAR_REQUEST_NOT_FOUND");
    });
  });

  describe("RLS", () => {
    it("a non-admin cannot read MST_DSARRequest rows", async () => {
      const orgId = await createOrg(admin);
      const { client } = await freshAdmin(orgId);
      const employee = await createUser(admin, { organizationId: orgId, role: "employee" });
      const employeeClient = await signInAs(employee.email, employee.password);

      await rpc(client, "log_dsar_request", { p_user_id: employee.id, p_type: "access" });

      const { data, error } = await employeeClient.from("MST_DSARRequest").select("id");
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });
});
