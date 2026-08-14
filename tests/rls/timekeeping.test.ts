// M3 timekeeping RPC suite: clock in/out, breaks, geofence, work-arrangement
// cascade. Same live-Supabase-required, graceful-skip pattern as the other
// tests/rls files.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { adminClient, isSupabaseReachable, signInAs } from "./client";
import { createOrg, createUser } from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn("\n[tests/rls] Local Supabase isn't reachable — skipping the M3 timekeeping suite.\n");
}

const GEOFENCE_CENTER = { lat: 14.5995, lng: 120.9842 }; // Manila
const FAR_AWAY = { lat: 40.7128, lng: -74.006 }; // New York — outside any sane radius

type ActiveSessionState = {
  state: "CLOCKED_OUT" | "CLOCKED_IN_IDLE" | "ON_CB" | "ON_LB";
  session: { id: string } | null;
  active_break: { id: string } | null;
};

// The generated types don't model nullable scalar RPC args (p_lat/p_lng can
// genuinely be null at runtime for denied/unavailable geo_status), so a
// direct rpc(client, ) call doesn't typecheck for those cases. This wrapper
// sidesteps that the same way lib/callRpc.ts does — real app code already
// goes through callRpc, so this friction is test-only. Typed <T> so callers
// don't need a cast at every use site.
async function rpc<T = unknown>(
  client: SupabaseClient<Database>,
  fn: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  const result = await client.rpc(fn as never, args as never);
  return result as unknown as { data: T | null; error: { message: string } | null };
}

async function getState(client: SupabaseClient<Database>): Promise<ActiveSessionState> {
  const { data } = await rpc(client, "get_active_session_state");
  return data as unknown as ActiveSessionState;
}

describe.skipIf(!reachable)("M3 timekeeping RPCs", () => {
  const admin = adminClient();

  async function freshEmployee(orgOpts?: Parameters<typeof createOrg>[1]) {
    const orgId = await createOrg(admin, orgOpts);
    const user = await createUser(admin, { organizationId: orgId, role: "employee" });
    const client = await signInAs(user.email, user.password);
    return { orgId, user, client };
  }

  describe("clock_in_user / clock_out_user", () => {
    it("clock in, then a second clock-in is rejected", async () => {
      const { client } = await freshEmployee();

      const first = await rpc(client, "clock_in_user", {
        p_lat: null,
        p_lng: null,
        p_geo_status: "unavailable",
      });
      expect(first.error).toBeNull();

      const second = await rpc(client, "clock_in_user", {
        p_lat: null,
        p_lng: null,
        p_geo_status: "unavailable",
      });
      expect(second.error?.message).toBe("USER_ALREADY_CLOCKED_IN");
    });

    it("concurrent clock-ins: exactly one succeeds (idx_open_work_session race)", async () => {
      const { client } = await freshEmployee();

      const attempts = await Promise.all(
        Array.from({ length: 5 }, () =>
          rpc(client, "clock_in_user", { p_lat: null, p_lng: null, p_geo_status: "unavailable" }),
        ),
      );

      const successes = attempts.filter((a) => a.error === null);
      const failures = attempts.filter((a) => a.error !== null);
      expect(successes).toHaveLength(1);
      expect(failures.every((f) => f.error?.message === "USER_ALREADY_CLOCKED_IN")).toBe(true);
    });

    it("clock_out_user with no active session fails", async () => {
      const { client } = await freshEmployee();
      const { error } = await rpc(client, "clock_out_user", {
        p_lat: null,
        p_lng: null,
        p_geo_status: "unavailable",
      });
      expect(error?.message).toBe("NO_ACTIVE_SESSION");
    });

    it("full cycle reflects in get_active_session_state", async () => {
      const { client } = await freshEmployee();

      expect((await getState(client)).state).toBe("CLOCKED_OUT");

      await rpc(client, "clock_in_user", { p_lat: null, p_lng: null, p_geo_status: "unavailable" });
      expect((await getState(client)).state).toBe("CLOCKED_IN_IDLE");

      const out = await rpc(client, "clock_out_user", {
        p_lat: null,
        p_lng: null,
        p_geo_status: "unavailable",
      });
      expect(out.error).toBeNull();

      expect((await getState(client)).state).toBe("CLOCKED_OUT");
    });

    it("denied/unavailable geo_status never blocks the punch and stores null coords", async () => {
      const { client } = await freshEmployee();

      const { error } = await rpc(client, "clock_in_user", {
        p_lat: 12.34,
        p_lng: 56.78,
        p_geo_status: "denied",
      });
      expect(error).toBeNull();

      const { data } = await admin
        .from("TIM_WorkSession")
        .select("clock_in_lat, clock_in_lng, clock_in_geo_status, clock_in_outside_boundary")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      expect(data?.clock_in_lat).toBeNull();
      expect(data?.clock_in_lng).toBeNull();
      expect(data?.clock_in_geo_status).toBe("denied");
      expect(data?.clock_in_outside_boundary).toBe(false);
    });

    it("rejects an invalid geo_status", async () => {
      const { client } = await freshEmployee();
      const { error } = await rpc(client, "clock_in_user", {
        p_lat: null,
        p_lng: null,
        p_geo_status: "bogus",
      });
      expect(error?.message).toBe("ERR_VALIDATION");
    });
  });

  describe("geofence + work-arrangement cascade", () => {
    it("office (default with no arrangement configured): outside geofence is flagged", async () => {
      const { client } = await freshEmployee({
        geofenceLatitude: GEOFENCE_CENTER.lat,
        geofenceLongitude: GEOFENCE_CENTER.lng,
        geofenceRadiusM: 200,
      });

      const { error } = await rpc(client, "clock_in_user", {
        p_lat: FAR_AWAY.lat,
        p_lng: FAR_AWAY.lng,
        p_geo_status: "checked",
      });
      expect(error).toBeNull();

      const { data } = await admin
        .from("TIM_WorkSession")
        .select("clock_in_outside_boundary")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      expect(data?.clock_in_outside_boundary).toBe(true);
    });

    it("inside the geofence radius is not flagged", async () => {
      const { client } = await freshEmployee({
        geofenceLatitude: GEOFENCE_CENTER.lat,
        geofenceLongitude: GEOFENCE_CENTER.lng,
        geofenceRadiusM: 200,
      });

      const { error } = await rpc(client, "clock_in_user", {
        p_lat: GEOFENCE_CENTER.lat,
        p_lng: GEOFENCE_CENTER.lng,
        p_geo_status: "checked",
      });
      expect(error).toBeNull();

      const { data } = await admin
        .from("TIM_WorkSession")
        .select("clock_in_outside_boundary")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      expect(data?.clock_in_outside_boundary).toBe(false);
    });

    it("wfh arrangement skips the geofence check entirely", async () => {
      const { orgId, user, client } = await freshEmployee({
        geofenceLatitude: GEOFENCE_CENTER.lat,
        geofenceLongitude: GEOFENCE_CENTER.lng,
        geofenceRadiusM: 200,
      });

      await admin.from("TIM_WorkArrangement").insert({
        organization_id: orgId,
        target_level: "user",
        target_id: user.id,
        arrangement: "wfh",
        effective_date: new Date().toISOString().slice(0, 10),
      });

      const { error } = await rpc(client, "clock_in_user", {
        p_lat: FAR_AWAY.lat,
        p_lng: FAR_AWAY.lng,
        p_geo_status: "checked",
      });
      expect(error).toBeNull();

      const { data } = await admin
        .from("TIM_WorkSession")
        .select("clock_in_outside_boundary")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      expect(data?.clock_in_outside_boundary).toBe(false);
    });

    it("hybrid defaults to office absent a day override: geofence still applies", async () => {
      const { orgId, user, client } = await freshEmployee({
        geofenceLatitude: GEOFENCE_CENTER.lat,
        geofenceLongitude: GEOFENCE_CENTER.lng,
        geofenceRadiusM: 200,
      });

      await admin.from("TIM_WorkArrangement").insert({
        organization_id: orgId,
        target_level: "user",
        target_id: user.id,
        arrangement: "hybrid",
        effective_date: new Date().toISOString().slice(0, 10),
      });

      const { error } = await rpc(client, "clock_in_user", {
        p_lat: FAR_AWAY.lat,
        p_lng: FAR_AWAY.lng,
        p_geo_status: "checked",
      });
      expect(error).toBeNull();

      const { data } = await admin
        .from("TIM_WorkSession")
        .select("clock_in_outside_boundary")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      expect(data?.clock_in_outside_boundary).toBe(true);
    });

    it("a day-level override wins over a standing user-level arrangement", async () => {
      const { orgId, user, client } = await freshEmployee({
        geofenceLatitude: GEOFENCE_CENTER.lat,
        geofenceLongitude: GEOFENCE_CENTER.lng,
        geofenceRadiusM: 200,
      });

      const today = new Date().toISOString().slice(0, 10);
      // Standing arrangement says office...
      await admin.from("TIM_WorkArrangement").insert({
        organization_id: orgId,
        target_level: "user",
        target_id: user.id,
        arrangement: "office",
        effective_date: "2020-01-01",
      });
      // ...but today's day-level override says wfh.
      await admin.from("TIM_WorkArrangement").insert({
        organization_id: orgId,
        target_level: "day",
        target_id: user.id,
        arrangement: "wfh",
        effective_date: today,
      });

      const { error } = await rpc(client, "clock_in_user", {
        p_lat: FAR_AWAY.lat,
        p_lng: FAR_AWAY.lng,
        p_geo_status: "checked",
      });
      expect(error).toBeNull();

      const { data } = await admin
        .from("TIM_WorkSession")
        .select("clock_in_outside_boundary")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      expect(data?.clock_in_outside_boundary).toBe(false);
    });
  });

  describe("breaks", () => {
    async function clockedInEmployee(orgOpts?: Parameters<typeof createOrg>[1]) {
      const ctx = await freshEmployee(orgOpts);
      await rpc(ctx.client, "clock_in_user", { p_lat: null, p_lng: null, p_geo_status: "unavailable" });
      return ctx;
    }

    it("start_cb -> state ON_CB; a second break type is rejected", async () => {
      const { client } = await clockedInEmployee();

      const start = await rpc(client, "start_cb");
      expect(start.error).toBeNull();

      expect((await getState(client)).state).toBe("ON_CB");

      const secondCb = await rpc(client, "start_cb");
      expect(secondCb.error?.message).toBe("BREAK_ALREADY_OPEN");

      const lbWhileCb = await rpc(client, "start_lb");
      expect(lbWhileCb.error?.message).toBe("BREAK_ALREADY_OPEN");
    });

    it("end_cb/end_lb without an open break fails with NO_ACTIVE_BREAK", async () => {
      const { client } = await clockedInEmployee();
      const endCb = await rpc(client, "end_cb");
      expect(endCb.error?.message).toBe("NO_ACTIVE_BREAK");
      const endLb = await rpc(client, "end_lb");
      expect(endLb.error?.message).toBe("NO_ACTIVE_BREAK");
    });

    it("CB_OVERTIME violation boundary: over max_cb_minutes flags, under doesn't", async () => {
      const { client } = await clockedInEmployee({ maxCbMinutes: 20 });

      const { data: breakId } = await rpc(client, "start_cb");
      // Backdate start_time so the break is already 25 minutes old (over the 20-minute cap).
      await admin
        .from("TIM_CompensableBreak")
        .update({ start_time: new Date(Date.now() - 25 * 60_000).toISOString() })
        .eq("id", breakId as string);

      const { error } = await rpc(client, "end_cb");
      expect(error).toBeNull();

      const { data } = await admin
        .from("TIM_CompensableBreak")
        .select("policy_violation, policy_violation_reason")
        .eq("id", breakId as string)
        .single();
      expect(data?.policy_violation).toBe(true);
      expect(data?.policy_violation_reason).toBe("CB_OVERTIME");
    });

    it("CB under the cap is not a violation", async () => {
      const { client } = await clockedInEmployee({ maxCbMinutes: 20 });
      const { data: breakId } = await rpc(client, "start_cb");
      const { error } = await rpc(client, "end_cb");
      expect(error).toBeNull();

      const { data } = await admin
        .from("TIM_CompensableBreak")
        .select("policy_violation")
        .eq("id", breakId as string)
        .single();
      expect(data?.policy_violation).toBe(false);
    });

    it("LB_SHORT violation boundary: under min_lb_minutes flags", async () => {
      const { client } = await clockedInEmployee({ minLbMinutes: 30 });
      const { data: breakId } = await rpc(client, "start_lb");

      const { error } = await rpc(client, "end_lb");
      expect(error).toBeNull();

      const { data } = await admin
        .from("TIM_NonCompensableBreak")
        .select("policy_violation, policy_violation_reason")
        .eq("id", breakId as string)
        .single();
      expect(data?.policy_violation).toBe(true);
      expect(data?.policy_violation_reason).toBe("LB_SHORT");
    });

    it("clock_out_user force-closes an open break and evaluates its violation", async () => {
      const { client } = await clockedInEmployee({ maxCbMinutes: 20 });

      const { data: breakId } = await rpc(client, "start_cb");
      await admin
        .from("TIM_CompensableBreak")
        .update({ start_time: new Date(Date.now() - 25 * 60_000).toISOString() })
        .eq("id", breakId as string);

      const { error } = await rpc(client, "clock_out_user", {
        p_lat: null,
        p_lng: null,
        p_geo_status: "unavailable",
      });
      expect(error).toBeNull();

      const { data } = await admin
        .from("TIM_CompensableBreak")
        .select("end_time, is_auto_closed, policy_violation, policy_violation_reason")
        .eq("id", breakId as string)
        .single();
      expect(data?.end_time).not.toBeNull();
      expect(data?.is_auto_closed).toBe(true);
      expect(data?.policy_violation).toBe(true);
      expect(data?.policy_violation_reason).toBe("CB_OVERTIME");

      expect((await getState(client)).state).toBe("CLOCKED_OUT");
    });

    it("clock_out_user force-closing an open LB never flags LB_SHORT (abandoned, not short)", async () => {
      const { client } = await clockedInEmployee({ minLbMinutes: 30 });
      const { data: breakId } = await rpc(client, "start_lb");

      const { error } = await rpc(client, "clock_out_user", {
        p_lat: null,
        p_lng: null,
        p_geo_status: "unavailable",
      });
      expect(error).toBeNull();

      const { data } = await admin
        .from("TIM_NonCompensableBreak")
        .select("is_auto_closed, policy_violation")
        .eq("id", breakId as string)
        .single();
      expect(data?.is_auto_closed).toBe(true);
      expect(data?.policy_violation).toBe(false);
    });
  });
});
