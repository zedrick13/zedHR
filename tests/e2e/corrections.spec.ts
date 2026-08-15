import { test, expect, type Browser } from "@playwright/test";
import * as OTPAuth from "otpauth";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function seedManagerAndEmployee(password: string) {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: org } = await admin
    .from("MST_Organization")
    .insert({ name: `E2E Corrections Org ${crypto.randomUUID()}`, pay_cycle_type: "monthly" })
    .select("id")
    .single();
  const { data: dept } = await admin
    .from("MST_Department")
    .insert({ organization_id: org!.id, name: "E2E Dept" })
    .select("id")
    .single();

  const managerEmail = `e2e-mgr-${crypto.randomUUID()}@zedhr.test`;
  const { data: managerAuth } = await admin.auth.admin.createUser({
    email: managerEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: managerAuth!.user!.id,
    organization_id: org!.id,
    department_id: dept!.id,
    first_name: "Manager",
    last_name: "E2E",
    role: "manager",
    is_active: true,
    mfa_enrolled: false,
  });
  await admin.from("MST_Department").update({ manager_id: managerAuth!.user!.id }).eq("id", dept!.id);

  const employeeEmail = `e2e-emp-${crypto.randomUUID()}@zedhr.test`;
  const { data: employeeAuth } = await admin.auth.admin.createUser({
    email: employeeEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: employeeAuth!.user!.id,
    organization_id: org!.id,
    department_id: dept!.id,
    first_name: "Employee",
    last_name: "E2E",
    role: "employee",
    is_active: true,
    mfa_enrolled: false,
  });

  // clock_in_time must fall on the same UTC calendar day as
  // pay_cycle_start_date (which defaults to current_date at org-creation
  // time) or the seeded session falls outside the pay cycle range the
  // timesheet page queries. An "N hours ago" offset can silently cross
  // that UTC-midnight boundary depending on when the suite happens to
  // run — use "just now" instead, which can't.
  const { data: session } = await admin
    .from("TIM_WorkSession")
    .insert({
      user_id: employeeAuth!.user!.id,
      organization_id: org!.id,
      clock_in_time: new Date(Date.now() - 10 * 60_000).toISOString(),
      clock_out_time: new Date().toISOString(),
      clock_in_geo_status: "unavailable",
    })
    .select("id")
    .single();

  return { managerEmail, employeeEmail, sessionId: session!.id };
}

async function loginAndDismissConsent(browser: Browser, baseURL: string, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseURL}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  return { context, page };
}

test("employee submits a correction, manager approves it from the dashboard", async ({ browser, baseURL }) => {
  const password = "E2ePassw0rd1";
  const { managerEmail, employeeEmail } = await seedManagerAndEmployee(password);
  const base = baseURL ?? "http://localhost:3000";

  // Employee: submit a correction request from the timesheet.
  const { context: employeeContext, page: employeePage } = await loginAndDismissConsent(
    browser,
    base,
    employeeEmail,
    password,
  );
  await expect(employeePage).toHaveURL("/", { timeout: 10_000 });
  await employeePage.goto("/timesheet");
  await employeePage.getByRole("button", { name: "Request correction" }).first().click();
  await employeePage.getByLabel("Correct time").fill("2026-08-01T09:00");
  await employeePage.getByLabel("Reason").fill("Actual clock-in was earlier than recorded");
  await employeePage.getByRole("button", { name: "Submit request" }).click();

  await employeePage.goto("/requests");
  await expect(employeePage.getByText("pending")).toBeVisible({ timeout: 10_000 });
  await employeeContext.close();

  // Manager: enroll MFA (mandatory, first login), then approve from the dashboard.
  const { page: managerPage } = await loginAndDismissConsent(browser, base, managerEmail, password);
  await expect(managerPage).toHaveURL(/\/mfa\/enroll/, { timeout: 10_000 });

  const secretText = await managerPage.locator("code").textContent();
  const totp = new OTPAuth.TOTP({ secret: secretText!.trim(), digits: 6, period: 30 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await managerPage.getByLabel("6-digit code").fill(totp.generate());
    await managerPage.getByRole("button", { name: "Verify" }).click();
    try {
      await expect(managerPage.getByText("Save your backup codes")).toBeVisible({ timeout: 5_000 });
      break;
    } catch {
      if (attempt === 2) throw new Error("TOTP verification failed after 3 attempts");
    }
  }
  await managerPage.getByRole("checkbox").check();
  await managerPage.getByRole("button", { name: "Continue" }).click();
  await expect(managerPage).toHaveURL("/", { timeout: 10_000 });

  await managerPage.goto("/dashboard");
  // "Employee E2E" now also appears in the M5 Direct Reports grid row, so
  // scope to the corrections queue list item specifically.
  await expect(managerPage.getByRole("listitem").getByText("Employee E2E")).toBeVisible({ timeout: 10_000 });
  await managerPage.getByRole("button", { name: "Approve" }).click();
  await expect(managerPage.getByText("No pending correction requests.")).toBeVisible({ timeout: 10_000 });
});
