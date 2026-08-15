import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function seedEmployee(email: string, password: string) {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: org, error: orgError } = await admin
    .from("MST_Organization")
    .insert({ name: `E2E Timekeeping Org ${crypto.randomUUID()}`, pay_cycle_type: "monthly" })
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
    first_name: "Timeclock",
    last_name: "Employee",
    role: "employee",
    is_active: true,
    mfa_enrolled: false,
  });
  if (profileError) throw new Error(`profile insert failed: ${profileError.message}`);
}

test("clock in, take a break, end break, clock out — full home-screen loop", async ({ page, context }) => {
  const email = `e2e-clock-${crypto.randomUUID()}@zedhr.test`;
  const password = "E2ePassw0rd1";
  await seedEmployee(email, password);

  // Without an explicit grant, headless Chromium's geolocation permission
  // prompt has no interactive user to resolve it and getCurrentPosition()
  // hangs indefinitely instead of erroring — grant it so the "checked" path
  // resolves deterministically (denied/unavailable are covered by the
  // backend RPC suite, tests/rls/timekeeping.test.ts).
  await context.grantPermissions(["geolocation"], { origin: "http://localhost:3000" });
  await context.setGeolocation({ latitude: 14.5995, longitude: 120.9842 });

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL("/", { timeout: 10_000 });

  // First-run GPS consent sheet renders after mount (it reads localStorage
  // in an effect) — wait for it rather than racing it.
  const gotIt = page.getByRole("button", { name: "Got it" });
  try {
    await gotIt.waitFor({ state: "visible", timeout: 3_000 });
    await gotIt.click();
  } catch {
    // Didn't appear in time — fine, nothing to dismiss.
  }

  await expect(page.getByRole("button", { name: "Clock In" })).toBeVisible();
  await page.getByRole("button", { name: "Clock In" }).click();

  await expect(page.getByRole("button", { name: "Clock Out" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Shift")).toBeVisible();

  await page.getByRole("button", { name: "Start Break" }).click();
  await expect(page.getByRole("button", { name: "End Break" })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "End Break" }).click();
  await expect(page.getByRole("button", { name: "Start Break" })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Clock Out" }).click();
  await expect(page.getByRole("button", { name: "Clock In" })).toBeVisible({ timeout: 10_000 });

  // The completed shift should now show up on the timesheet.
  await page.goto("/timesheet");
  await expect(page.getByText("Ok").or(page.getByText("No GPS"))).toBeVisible({ timeout: 10_000 });
});
