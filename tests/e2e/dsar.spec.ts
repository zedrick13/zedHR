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

test("admin logs a DSAR access request, downloads the CSV, then resolves it", async ({ page }) => {
  const password = "E2ePassw0rd1";
  const admin = adminClient();

  const { data: org } = await admin
    .from("MST_Organization")
    .insert({ name: `E2E DSAR Org ${crypto.randomUUID()}`, pay_cycle_type: "monthly" })
    .select("id")
    .single();

  const adminEmail = `e2e-dsar-admin-${crypto.randomUUID()}@zedhr.test`;
  const { data: adminAuth } = await admin.auth.admin.createUser({
    email: adminEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: adminAuth!.user!.id,
    organization_id: org!.id,
    first_name: "DSAR",
    last_name: "Admin",
    role: "admin",
    is_active: true,
    mfa_enrolled: false,
  });

  const employeeEmail = `e2e-dsar-emp-${crypto.randomUUID()}@zedhr.test`;
  const { data: employeeAuth } = await admin.auth.admin.createUser({
    email: employeeEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: employeeAuth!.user!.id,
    organization_id: org!.id,
    first_name: "DSAR",
    last_name: "Subject",
    role: "employee",
    is_active: true,
    mfa_enrolled: false,
  });
  await admin.from("TIM_WorkSession").insert({
    user_id: employeeAuth!.user!.id,
    organization_id: org!.id,
    clock_in_time: new Date(Date.now() - 3_600_000).toISOString(),
    clock_out_time: new Date().toISOString(),
    clock_in_geo_status: "unavailable",
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill(adminEmail);
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

  await page.goto("/admin/dsar");
  await expect(page.getByRole("heading", { name: "Log a new request" })).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("Employee").selectOption({ label: "DSAR Subject" });
  await page.getByLabel("Request type").selectOption("access");
  await page.getByLabel("Notes").fill("Employee requested a copy of their records.");
  await page.getByRole("button", { name: "Log request" }).click();
  await expect(page.getByText("Request logged.")).toBeVisible({ timeout: 10_000 });

  await expect(page.getByRole("heading", { name: "Pending (1)" })).toBeVisible();
  await expect(page.getByRole("listitem").getByText("DSAR Subject")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^dsar-.*\.csv$/);

  await page.getByRole("button", { name: "Resolve" }).click();
  await page.getByPlaceholder("Resolution note (optional)").fill("CSV handed over via secure channel");
  await page.getByRole("button", { name: "Confirm resolve" }).click();

  await expect(page.getByRole("heading", { name: "Pending (0)" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Resolved" })).toBeVisible();
  await expect(page.getByText(/Resolved .* CSV handed over via secure channel/)).toBeVisible();
});
