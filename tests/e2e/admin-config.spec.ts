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

test("admin drives departments, work arrangements, holidays, org settings, and audit log through the browser", async ({
  page,
}) => {
  const password = "E2ePassw0rd1";
  const admin = adminClient();

  const { data: org } = await admin
    .from("MST_Organization")
    .insert({ name: `E2E Admin Config Org ${crypto.randomUUID()}`, pay_cycle_type: "monthly" })
    .select("id")
    .single();

  const adminEmail = `e2e-adminconfig-admin-${crypto.randomUUID()}@zedhr.test`;
  const { data: adminAuth } = await admin.auth.admin.createUser({
    email: adminEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: adminAuth!.user!.id,
    organization_id: org!.id,
    first_name: "Config",
    last_name: "Admin",
    role: "admin",
    is_active: true,
    mfa_enrolled: false,
  });

  const managerEmail = `e2e-adminconfig-mgr-${crypto.randomUUID()}@zedhr.test`;
  const { data: managerAuth } = await admin.auth.admin.createUser({
    email: managerEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: managerAuth!.user!.id,
    organization_id: org!.id,
    first_name: "Riley",
    last_name: "Manager",
    role: "manager",
    is_active: true,
    mfa_enrolled: false,
  });

  const employeeEmail = `e2e-adminconfig-emp-${crypto.randomUUID()}@zedhr.test`;
  const { data: employeeAuth } = await admin.auth.admin.createUser({
    email: employeeEmail,
    password,
    email_confirm: true,
  });
  await admin.from("MST_User").insert({
    id: employeeAuth!.user!.id,
    organization_id: org!.id,
    first_name: "Sam",
    last_name: "Employee",
    role: "employee",
    is_active: true,
    mfa_enrolled: false,
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

  // Departments: create, then inline-edit (exercises the fk_department_manager embed hint).
  await page.goto("/admin/departments");
  await expect(page.getByRole("heading", { name: "New department" })).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("Name").fill("Engineering");
  await page.getByLabel("Manager").selectOption({ label: "Riley Manager" });
  await page.getByRole("button", { name: "Create department" }).click();
  await expect(page.getByText("Engineering — Riley Manager")).toBeVisible({ timeout: 10_000 });

  const departmentRow = page.getByRole("listitem").first();
  await departmentRow.getByRole("button", { name: "Edit" }).click();
  await departmentRow.getByLabel("Name").fill("Platform Engineering");
  await departmentRow.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Platform Engineering — Riley Manager")).toBeVisible({ timeout: 10_000 });

  // Work arrangements: default preview, then set a standing arrangement and confirm the cascade preview updates.
  await page.goto("/admin/work-arrangements");
  await expect(page.getByRole("heading", { name: "Set an arrangement" })).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("Employee").selectOption({ label: "Sam Employee" });
  await expect(page.getByText(/currently resolves to office already/)).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("Arrangement").selectOption("wfh");
  await page.getByLabel("Effective date").fill("2026-08-01");
  await expect(page.getByText(/will become "wfh" after this change/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Set arrangement" }).click();
  await expect(page.getByText("Arrangement saved.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/user — Sam Employee — wfh \(2026-08-01\)/)).toBeVisible();

  // Holidays: create then delete.
  await page.goto("/admin/holidays");
  await expect(page.getByRole("heading", { name: "New holiday" })).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("Date").fill("2026-12-25");
  await page.getByLabel("Name").fill("Christmas Day");
  await page.getByRole("button", { name: "Create holiday" }).click();
  await expect(page.getByText(/2026-12-25 — Christmas Day \(regular\)/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No holidays yet.")).toBeVisible({ timeout: 10_000 });

  // Org settings: update and confirm the save round-trips.
  await page.goto("/admin/org-settings");
  await expect(page.getByLabel("Max paid break minutes")).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("Max paid break minutes").fill("25");
  await page.getByLabel("Min lunch break minutes").fill("45");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(page.getByLabel("Max paid break minutes")).toHaveValue("25");

  // Audit log: confirm the actions above landed, and the actor-name embed resolves (AUD_SystemLog_actor_id_fkey).
  await page.goto("/admin/audit-log");
  await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("cell", { name: "DEPARTMENT_CREATED" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("row", { name: /DEPARTMENT_CREATED/ }).getByRole("cell", { name: "Config Admin" })).toBeVisible();

  await page.getByLabel("Filter by action type").selectOption("ORG_SETTINGS_UPDATED");
  await expect(page).toHaveURL(/action_type=ORG_SETTINGS_UPDATED/);
  await expect(page.getByRole("cell", { name: "ORG_SETTINGS_UPDATED" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("cell", { name: "DEPARTMENT_CREATED" })).not.toBeVisible();
});
