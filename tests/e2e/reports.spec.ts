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

test("reports pane: filters render and CSV export downloads a file", async ({ page }) => {
  const password = "E2ePassw0rd1";
  const admin = adminClient();

  const { data: org } = await admin
    .from("MST_Organization")
    .insert({ name: `E2E Reports Org ${crypto.randomUUID()}`, pay_cycle_type: "monthly" })
    .select("id")
    .single();
  const { data: dept } = await admin
    .from("MST_Department")
    .insert({ organization_id: org!.id, name: "E2E Reports Dept" })
    .select("id")
    .single();

  const managerEmail = `e2e-report-mgr-${crypto.randomUUID()}@zedhr.test`;
  const { data: managerAuth } = await admin.auth.admin.createUser({
    email: managerEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: managerAuth!.user!.id,
    organization_id: org!.id,
    department_id: dept!.id,
    first_name: "Report",
    last_name: "Manager",
    role: "manager",
    is_active: true,
    mfa_enrolled: false,
  });
  await admin.from("MST_Department").update({ manager_id: managerAuth!.user!.id }).eq("id", dept!.id);

  const employeeEmail = `e2e-report-emp-${crypto.randomUUID()}@zedhr.test`;
  const { data: employeeAuth } = await admin.auth.admin.createUser({
    email: employeeEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: employeeAuth!.user!.id,
    organization_id: org!.id,
    department_id: dept!.id,
    first_name: "Report",
    last_name: "Employee",
    role: "employee",
    is_active: true,
    mfa_enrolled: false,
  });
  await admin.from("TIM_WorkSession").insert({
    user_id: employeeAuth!.user!.id,
    organization_id: org!.id,
    clock_in_time: new Date(Date.now() - 3 * 3600_000).toISOString(),
    clock_out_time: new Date().toISOString(),
    clock_in_geo_status: "unavailable",
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
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("cell", { name: "Report Employee" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^timesheet-report-.*\.csv$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const csvText = Buffer.concat(chunks).toString("utf-8");
  expect(csvText).toContain("Employee,Department,Date,Clock In,Clock Out");
  expect(csvText).toContain("Report Employee");

  await expect(page.getByText(/Exported \d+ row\(s\)\./)).toBeVisible({ timeout: 10_000 });
});
