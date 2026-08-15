import { test, expect } from "@playwright/test";
import * as OTPAuth from "otpauth";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function seedUser(email: string, password: string, role: "admin" | "employee") {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: org, error: orgError } = await admin
    .from("MST_Organization")
    .insert({ name: `E2E Org ${crypto.randomUUID()}`, pay_cycle_type: "monthly" })
    .select("id")
    .single();
  if (orgError || !org) throw new Error(`org insert failed: ${orgError?.message}`);

  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !authUser.user) throw new Error(`createUser failed: ${authError?.message}`);

  const { error: profileError } = await admin.from("MST_User").insert({
    id: authUser.user.id,
    organization_id: org.id,
    first_name: "E2E",
    last_name: role === "admin" ? "Admin" : "Employee",
    role,
    is_active: true,
    mfa_enrolled: false,
  });
  if (profileError) throw new Error(`profile insert failed: ${profileError.message}`);
}

test("login -> forced MFA enrollment -> home, for a fresh admin", async ({ page }) => {
  const email = `e2e-admin-${crypto.randomUUID()}@zedhr.test`;
  const password = "E2ePassw0rd1";
  await seedUser(email, password, "admin");

  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/mfa\/enroll/, { timeout: 10_000 });

  const secretText = await page.locator("code").textContent();
  expect(secretText).toBeTruthy();
  const totp = new OTPAuth.TOTP({ secret: secretText!.trim(), digits: 6, period: 30 });

  // Regenerate right before each submit attempt (not once up front): dev-
  // server compile latency can otherwise push us past the 30s TOTP window.
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
  const codes = await page.locator("li").allTextContents();
  expect(codes.length).toBeGreaterThanOrEqual(8);

  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByText(/Hi, E2E/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
});

test("employee login never routes through MFA (SPEC §7: mandatory for manager/admin only)", async ({
  page,
}) => {
  const email = `e2e-employee-${crypto.randomUUID()}@zedhr.test`;
  const password = "E2ePassw0rd1";
  await seedUser(email, password, "employee");

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL("/", { timeout: 10_000 });
  await expect(page.getByText(/Hi, E2E/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).not.toBeVisible();
});
