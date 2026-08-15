import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function seedManagerAndEmployee(password: string) {
  const admin = adminClient();

  const { data: org } = await admin
    .from("MST_Organization")
    .insert({ name: `E2E Offline Org ${crypto.randomUUID()}`, pay_cycle_type: "monthly" })
    .select("id")
    .single();
  const { data: dept } = await admin
    .from("MST_Department")
    .insert({ organization_id: org!.id, name: "E2E Offline Dept" })
    .select("id")
    .single();

  const managerEmail = `e2e-offline-mgr-${crypto.randomUUID()}@zedhr.test`;
  const { data: managerAuth } = await admin.auth.admin.createUser({
    email: managerEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: managerAuth!.user!.id,
    organization_id: org!.id,
    department_id: dept!.id,
    first_name: "Offline",
    last_name: "Manager",
    role: "manager",
    is_active: true,
    mfa_enrolled: false,
  });
  await admin.from("MST_Department").update({ manager_id: managerAuth!.user!.id }).eq("id", dept!.id);

  const employeeEmail = `e2e-offline-emp-${crypto.randomUUID()}@zedhr.test`;
  const { data: employeeAuth } = await admin.auth.admin.createUser({
    email: employeeEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: employeeAuth!.user!.id,
    organization_id: org!.id,
    department_id: dept!.id,
    first_name: "Offline",
    last_name: "Employee",
    role: "employee",
    is_active: true,
    mfa_enrolled: false,
  });

  return { orgId: org!.id as string, managerId: managerAuth!.user!.id as string, employeeId: employeeAuth!.user!.id as string, employeeEmail };
}

async function dismissGpsConsent(page: import("@playwright/test").Page) {
  const gotIt = page.getByRole("button", { name: "Got it" });
  try {
    await gotIt.waitFor({ state: "visible", timeout: 3_000 });
    await gotIt.click();
  } catch {
    // Didn't appear in time — fine, nothing to dismiss.
  }
}

test("punching while offline queues locally, then syncs to a single session on reconnect", async ({ page, context }) => {
  const password = "E2ePassw0rd1";
  const { orgId, employeeId, employeeEmail } = await seedManagerAndEmployee(password);
  const admin = adminClient();

  await page.goto("/login");
  await page.getByLabel("Email").fill(employeeEmail);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 10_000 });
  await dismissGpsConsent(page);

  await context.setOffline(true);
  await page.getByRole("button", { name: "Clock In" }).click();
  await expect(page.getByText(/punch queued offline/)).toBeVisible({ timeout: 10_000 });

  const { data: whileOffline } = await admin
    .from("TIM_WorkSession")
    .select("id")
    .eq("user_id", employeeId);
  expect(whileOffline).toHaveLength(0);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await expect(page.getByRole("button", { name: "Clock Out" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/punch queued offline/)).not.toBeVisible();

  const { data: sessions } = await admin
    .from("TIM_WorkSession")
    .select("id, clock_out_time")
    .eq("user_id", employeeId)
    .eq("organization_id", orgId);
  expect(sessions).toHaveLength(1);
  expect(sessions?.[0].clock_out_time).toBeNull();
});

test("a stale queued retry for an already-applied clock-in dequeues with zero false conflicts", async ({ page }) => {
  const password = "E2ePassw0rd1";
  const { orgId, employeeId, employeeEmail } = await seedManagerAndEmployee(password);
  const admin = adminClient();

  // The real call already succeeded server-side; only the response was
  // lost — the client-side queue still has an (now stale) retry pending.
  await admin.from("TIM_WorkSession").insert({
    user_id: employeeId,
    organization_id: orgId,
    clock_in_time: new Date().toISOString(),
    clock_in_geo_status: "unavailable",
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill(employeeEmail);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 10_000 });
  await dismissGpsConsent(page);

  await page.evaluate(() => {
    const item = {
      id: crypto.randomUUID(),
      action: "clock_in",
      payload: { attempted_timestamp: new Date().toISOString(), lat: null, lng: null },
    };
    localStorage.setItem("zedhr_punch_queue", JSON.stringify([item]));
    localStorage.setItem("zedhr_offline_since", new Date().toISOString());
  });
  await page.reload();
  await dismissGpsConsent(page);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("zedhr_punch_queue")), { timeout: 10_000 })
    .toBe("[]");

  const { data: conflicts } = await admin
    .from("TIM_SyncConflict")
    .select("id")
    .eq("organization_id", orgId)
    .eq("user_id", employeeId);
  expect(conflicts).toHaveLength(0);

  const { data: sessions } = await admin
    .from("TIM_WorkSession")
    .select("id")
    .eq("user_id", employeeId)
    .eq("organization_id", orgId);
  expect(sessions).toHaveLength(1);
});

test("a genuine overlap (break already started elsewhere) logs a conflict and notifies the manager", async ({
  page,
}) => {
  const password = "E2ePassw0rd1";
  const { orgId, managerId, employeeId, employeeEmail } = await seedManagerAndEmployee(password);
  const admin = adminClient();

  const { data: session } = await admin
    .from("TIM_WorkSession")
    .insert({
      user_id: employeeId,
      organization_id: orgId,
      clock_in_time: new Date().toISOString(),
      clock_in_geo_status: "unavailable",
    })
    .select("id")
    .single();
  // A break already open on this session (e.g. started from another
  // device) — the queued start_cb below genuinely conflicts with it.
  await admin.from("TIM_CompensableBreak").insert({
    organization_id: orgId,
    work_session_id: session!.id,
    start_time: new Date().toISOString(),
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill(employeeEmail);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 10_000 });
  await dismissGpsConsent(page);

  await page.evaluate(() => {
    const item = {
      id: crypto.randomUUID(),
      action: "start_cb",
      payload: { attempted_timestamp: new Date().toISOString(), lat: null, lng: null },
    };
    localStorage.setItem("zedhr_punch_queue", JSON.stringify([item]));
    localStorage.setItem("zedhr_offline_since", new Date().toISOString());
  });
  await page.reload();
  await dismissGpsConsent(page);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("zedhr_punch_queue")), { timeout: 10_000 })
    .toBe("[]");

  const { data: conflicts } = await admin
    .from("TIM_SyncConflict")
    .select("failed_action")
    .eq("organization_id", orgId)
    .eq("user_id", employeeId);
  expect(conflicts).toHaveLength(1);
  expect(conflicts?.[0].failed_action).toBe("start_cb");

  const { data: notifications } = await admin
    .from("NTF_Notification")
    .select("template")
    .eq("recipient_id", managerId)
    .eq("template", "F");
  expect(notifications).toHaveLength(1);
});
