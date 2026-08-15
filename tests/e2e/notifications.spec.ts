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

async function seedEmployee(email: string, password: string) {
  const admin = adminClient();

  const { data: org, error: orgError } = await admin
    .from("MST_Organization")
    .insert({ name: `E2E Notifications Org ${crypto.randomUUID()}`, pay_cycle_type: "monthly" })
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
    first_name: "Notify",
    last_name: "Employee",
    role: "employee",
    is_active: true,
    mfa_enrolled: false,
  });
  if (profileError) throw new Error(`profile insert failed: ${profileError.message}`);

  return { organizationId: org.id, userId: authUser.user.id };
}

test("notification bell: badge, popover, mark-read on click, and live realtime insert", async ({ page }) => {
  const email = `e2e-notify-${crypto.randomUUID()}@zedhr.test`;
  const password = "E2ePassw0rd1";
  const { organizationId, userId } = await seedEmployee(email, password);
  const admin = adminClient();

  await admin.from("NTF_Notification").insert({
    organization_id: organizationId,
    recipient_id: userId,
    template: "D",
    title: "Correction approved",
    body: "Your timesheet correction request was approved.",
    link_path: "/requests",
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 10_000 });

  // First-run GPS consent sheet renders after mount (it reads localStorage
  // in an effect) — wait for it rather than racing it, same as timekeeping.spec.ts.
  const gotIt = page.getByRole("button", { name: "Got it" });
  try {
    await gotIt.waitFor({ state: "visible", timeout: 3_000 });
    await gotIt.click();
  } catch {
    // Didn't appear in time — fine, nothing to dismiss.
  }

  const bell = page.getByRole("button", { name: /Notifications, 1 unread/ });
  await expect(bell).toBeVisible({ timeout: 10_000 });

  await bell.click();
  await expect(page.getByText("Correction approved")).toBeVisible();

  // Realtime insert lands without a page refresh.
  await admin.from("NTF_Notification").insert({
    organization_id: organizationId,
    recipient_id: userId,
    template: "B",
    title: "New correction request",
    body: "Someone submitted a timesheet correction request.",
    link_path: "/requests",
  });
  await expect(page.getByText("New correction request")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /Notifications, 2 unread/ })).toBeVisible();

  // Clicking a notification marks it read and deep-links to link_path.
  await page.getByText("Correction approved").click();
  await expect(page).toHaveURL("/requests", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: /Notifications, 1 unread/ })).toBeVisible({ timeout: 10_000 });

  const { data: readRow } = await admin
    .from("NTF_Notification")
    .select("is_read, read_at")
    .eq("recipient_id", userId)
    .eq("title", "Correction approved")
    .single();
  expect(readRow?.is_read).toBe(true);
  expect(readRow?.read_at).not.toBeNull();
});
