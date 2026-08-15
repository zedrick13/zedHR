import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import * as OTPAuth from "otpauth";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

test("manager dashboard: headcount widget + Direct Reports grid, live-updates on clock-in", async ({ page }) => {
  const password = "E2ePassw0rd1";
  const admin = adminClient();

  const { data: org } = await admin
    .from("MST_Organization")
    .insert({ name: `E2E Dashboard Org ${crypto.randomUUID()}`, pay_cycle_type: "monthly" })
    .select("id")
    .single();
  const { data: dept } = await admin
    .from("MST_Department")
    .insert({ organization_id: org!.id, name: "E2E Dept" })
    .select("id")
    .single();

  const managerEmail = `e2e-dash-mgr-${crypto.randomUUID()}@zedhr.test`;
  const { data: managerAuth } = await admin.auth.admin.createUser({
    email: managerEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: managerAuth!.user!.id,
    organization_id: org!.id,
    department_id: dept!.id,
    first_name: "Dash",
    last_name: "Manager",
    role: "manager",
    is_active: true,
    mfa_enrolled: false,
  });
  await admin.from("MST_Department").update({ manager_id: managerAuth!.user!.id }).eq("id", dept!.id);

  const employeeEmail = `e2e-dash-emp-${crypto.randomUUID()}@zedhr.test`;
  const { data: employeeAuth } = await admin.auth.admin.createUser({
    email: employeeEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: employeeAuth!.user!.id,
    organization_id: org!.id,
    department_id: dept!.id,
    first_name: "Dash",
    last_name: "Employee",
    role: "employee",
    is_active: true,
    mfa_enrolled: false,
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill(managerEmail);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/mfa\/enroll/, { timeout: 10_000 });

  const secretText = await page.locator("code").textContent();
  const totp = new OTPAuth.TOTP({ secret: secretText!.trim(), digits: 6, period: 30 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByLabel("6-digit code").fill(totp.generate());
    await page.getByRole("button", { name: "Verify" }).click();
    try {
      await expect(page.getByText("Save your backup codes")).toBeVisible({ timeout: 5_000 });
      break;
    } catch {
      if (attempt === 2) throw new Error("TOTP verification failed after 3 attempts");
    }
  }
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL("/", { timeout: 10_000 });

  await page.goto("/dashboard");
  await expect(page.getByRole("cell", { name: "Dash Employee" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Direct reports" })).toBeVisible();
  await expect(page.getByText("Clocked Out")).toBeVisible();

  // Live update: the employee clocks in server-side (no employee browser
  // session needed for this check) and the grid should reflect it without
  // a page refresh, via the Realtime subscription.
  await admin.from("TIM_WorkSession").insert({
    user_id: employeeAuth!.user!.id,
    organization_id: org!.id,
    clock_in_time: new Date().toISOString(),
    clock_in_geo_status: "unavailable",
  });

  await expect(page.getByText("Clocked In")).toBeVisible({ timeout: 10_000 });
});
