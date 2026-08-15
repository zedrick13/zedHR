import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

// The get_avatar_upload_url Edge Function can't run in this sandbox (no
// working container runtime for edge-runtime here), so this spec only
// covers the client-side validation that happens before that network
// call — file type and size are checked locally first.
async function seedEmployee(email: string, password: string) {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: org } = await admin
    .from("MST_Organization")
    .insert({ name: `E2E Profile Org ${crypto.randomUUID()}`, pay_cycle_type: "monthly" })
    .select("id")
    .single();

  const { data: authUser } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  await admin.from("MST_User").insert({
    id: authUser!.user!.id,
    organization_id: org!.id,
    first_name: "Profile",
    last_name: "Employee",
    role: "employee",
    is_active: true,
    mfa_enrolled: false,
  });
}

test("profile page: avatar upload rejects the wrong file type and oversized files client-side", async ({ page }) => {
  const email = `e2e-profile-${crypto.randomUUID()}@zedhr.test`;
  const password = "E2ePassw0rd1";
  await seedEmployee(email, password);

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 10_000 });

  await page.goto("/profile");
  await expect(page.getByText("Profile Employee")).toBeVisible({ timeout: 10_000 });

  const fileInput = page.locator('input[type="file"]');

  await fileInput.setInputFiles({
    name: "resume.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.getByText("Please choose a PNG or JPEG image.")).toBeVisible({ timeout: 10_000 });

  await fileInput.setInputFiles({
    name: "huge.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(3 * 1024 * 1024),
  });
  await expect(page.getByText("Image must be 2MB or smaller.")).toBeVisible({ timeout: 10_000 });
});
