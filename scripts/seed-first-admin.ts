/**
 * Manual-run only. Never wire this into a deploy step (CLAUDE.md "Secrets &
 * safety"). Creates the organization row and the first admin user with a
 * temp password that must be changed + MFA-enrolled on first login (SPEC
 * §7 "Provisioning" — no bypass of that flow).
 *
 * Usage:
 *   SUPABASE_SERVICE_ROLE_KEY=... NEXT_PUBLIC_SUPABASE_URL=... \
 *     pnpm tsx scripts/seed-first-admin.ts --email admin@example.com --name "Ada Lovelace"
 */
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };

  const email = get("--email");
  const name = get("--name");
  const orgName = get("--org") ?? "zedHR";
  const payCycleType = get("--pay-cycle") ?? "monthly";

  if (!email || !name) {
    console.error(
      "Usage: pnpm tsx scripts/seed-first-admin.ts --email <email> --name \"First Last\" [--org <org name>] [--pay-cycle weekly|biweekly|monthly]",
    );
    process.exit(1);
  }

  if (!["weekly", "biweekly", "monthly"].includes(payCycleType)) {
    console.error("--pay-cycle must be one of: weekly, biweekly, monthly");
    process.exit(1);
  }

  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ") || firstName;

  return {
    email,
    firstName,
    lastName,
    orgName,
    payCycleType: payCycleType as "weekly" | "biweekly" | "monthly",
  };
}

function generateTempPassword(): string {
  // >= 10 chars, at least one letter and one number (SPEC §7 password policy).
  return `Zh-${randomBytes(9).toString("base64url")}`;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    console.error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (never commit these).",
    );
    process.exit(1);
  }

  const { email, firstName, lastName, orgName, payCycleType } = parseArgs();
  const supabase = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: org, error: orgError } = await supabase
    .from("MST_Organization")
    .insert({ name: orgName, pay_cycle_type: payCycleType })
    .select("id")
    .single();

  if (orgError || !org) {
    console.error("Failed to create organization:", orgError?.message);
    process.exit(1);
  }

  const tempPassword = generateTempPassword();

  const { data: authUser, error: authError } =
    await supabase.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
    });

  if (authError || !authUser.user) {
    console.error("Failed to create auth user:", authError?.message);
    process.exit(1);
  }

  const { error: profileError } = await supabase.from("MST_User").insert({
    id: authUser.user.id,
    organization_id: org.id,
    first_name: firstName,
    last_name: lastName,
    role: "admin",
    is_active: true,
    mfa_enrolled: false,
  });

  if (profileError) {
    console.error("Failed to create MST_User row:", profileError.message);
    process.exit(1);
  }

  console.log("First admin created.");
  console.log(`  Organization: ${orgName} (${org.id})`);
  console.log(`  Email:        ${email}`);
  console.log(`  Temp password: ${tempPassword}`);
  console.log(
    "Share the temp password out-of-band. The admin must change it and enroll MFA on first login.",
  );
}

main();
