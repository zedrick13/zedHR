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

// No Database generic here: MST_Organization/MST_User aren't in the
// generated types until the M1 migrations land (this script is a M0
// deliverable per CLAUDE.md, ahead of the schema it seeds).

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };

  const email = get("--email");
  const name = get("--name");
  const orgName = get("--org") ?? "zedHR";

  if (!email || !name) {
    console.error(
      "Usage: pnpm tsx scripts/seed-first-admin.ts --email <email> --name \"First Last\" [--org <org name>]",
    );
    process.exit(1);
  }

  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ") || firstName;

  return { email, firstName, lastName, orgName };
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

  const { email, firstName, lastName, orgName } = parseArgs();
  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: org, error: orgError } = await supabase
    .from("MST_Organization")
    .insert({ name: orgName })
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
