import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type Role = "employee" | "manager" | "admin";

const TEST_PASSWORD = "Zh-test-fixture-pw1";

export async function createOrg(
  admin: SupabaseClient<Database>,
  opts: {
    geofenceLatitude?: number;
    geofenceLongitude?: number;
    geofenceRadiusM?: number;
    maxCbMinutes?: number;
    minLbMinutes?: number;
  } = {},
) {
  const { data, error } = await admin
    .from("MST_Organization")
    .insert({
      name: `Test Org ${randomUUID()}`,
      pay_cycle_type: "monthly",
      geofence_latitude: opts.geofenceLatitude,
      geofence_longitude: opts.geofenceLongitude,
      geofence_radius_m: opts.geofenceRadiusM,
      max_cb_minutes: opts.maxCbMinutes,
      min_lb_minutes: opts.minLbMinutes,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`createOrg failed: ${error?.message}`);
  }

  return data.id;
}

export async function createDepartment(
  admin: SupabaseClient<Database>,
  organizationId: string,
  name = `Dept ${randomUUID()}`,
) {
  const { data, error } = await admin
    .from("MST_Department")
    .insert({ organization_id: organizationId, name })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`createDepartment failed: ${error?.message}`);
  }

  return data.id;
}

export async function createUser(
  admin: SupabaseClient<Database>,
  opts: {
    organizationId: string;
    role: Role;
    departmentId?: string | null;
  },
) {
  const email = `${randomUUID()}@zedhr.test`;

  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });

  if (authError || !authUser.user) {
    throw new Error(`createUser auth failed: ${authError?.message}`);
  }

  const { error: profileError } = await admin.from("MST_User").insert({
    id: authUser.user.id,
    organization_id: opts.organizationId,
    department_id: opts.departmentId ?? null,
    first_name: "Test",
    last_name: "User",
    role: opts.role,
    is_active: true,
    mfa_enrolled: false,
  });

  if (profileError) {
    throw new Error(`createUser profile failed: ${profileError.message}`);
  }

  return { id: authUser.user.id, email, password: TEST_PASSWORD };
}

export async function setDepartmentManager(
  admin: SupabaseClient<Database>,
  departmentId: string,
  managerId: string,
) {
  const { error } = await admin
    .from("MST_Department")
    .update({ manager_id: managerId })
    .eq("id", departmentId);

  if (error) {
    throw new Error(`setDepartmentManager failed: ${error.message}`);
  }
}

export async function createWorkSession(
  admin: SupabaseClient<Database>,
  opts: { userId: string; organizationId: string },
) {
  const { data, error } = await admin
    .from("TIM_WorkSession")
    .insert({
      user_id: opts.userId,
      organization_id: opts.organizationId,
      clock_in_time: new Date().toISOString(),
      clock_in_geo_status: "unavailable",
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`createWorkSession failed: ${error?.message}`);
  }

  return data.id;
}

export async function createNotification(
  admin: SupabaseClient<Database>,
  opts: { organizationId: string; recipientId: string },
) {
  const { data, error } = await admin
    .from("NTF_Notification")
    .insert({
      organization_id: opts.organizationId,
      recipient_id: opts.recipientId,
      template: "D",
      title: "Test notification",
      body: "Test body",
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`createNotification failed: ${error?.message}`);
  }

  return data.id;
}
