/**
 * Provisions the org row + first admin user (SPEC.md §7). Manual-run only —
 * never wire this into deploy (CLAUDE.md "Secrets & safety"). Requires
 * SUPABASE_SERVICE_ROLE_KEY, which must never leave this local invocation.
 *
 * Usage:
 *   pnpm seed:first-admin -- --org "Acme Inc" --email admin@acme.com --first Ada --last Lovelace
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

interface Args {
  org: string;
  email: string;
  first: string;
  last: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(`--${flag}`);
    return i === -1 ? undefined : args[i + 1];
  };

  const org = get("org");
  const email = get("email");
  const first = get("first");
  const last = get("last");

  if (!org || !email || !first || !last) {
    console.error("Usage: pnpm seed:first-admin -- --org <name> --email <email> --first <name> --last <name>");
    process.exit(1);
  }

  return { org, email, first, last };
}

function generateTempPassword(): string {
  // >=10 chars, >=1 letter, >=1 number (SPEC.md §7 password policy).
  return `${randomBytes(9).toString("base64url")}A1`;
}

async function main() {
  const { org, email, first, last } = parseArgs();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (local .env only).");
    process.exit(1);
  }

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: orgRow, error: orgError } = await supabase
    .from("MST_Organization")
    .insert({ name: org, timezone: "Asia/Manila" })
    .select("id")
    .single<{ id: string }>();

  if (orgError || !orgRow) {
    console.error("Failed to create organization:", orgError?.message);
    process.exit(1);
  }

  const tempPassword = generateTempPassword();

  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
  });

  if (authError || !authUser.user) {
    console.error("Failed to create auth user:", authError?.message);
    process.exit(1);
  }

  const { error: userError } = await supabase.from("MST_User").insert({
    id: authUser.user.id,
    organization_id: orgRow.id,
    first_name: first,
    last_name: last,
    role: "admin",
    is_active: true,
    mfa_enrolled: false,
  });

  if (userError) {
    console.error("Failed to create MST_User row:", userError.message);
    process.exit(1);
  }

  console.log("First admin provisioned.");
  console.log(`  Organization: ${org} (${orgRow.id})`);
  console.log(`  Email:        ${email}`);
  console.log(`  Temp password: ${tempPassword}`);
  console.log(
    "\nHand this password to the admin out-of-band (do not paste it into chat/ticket/CI logs). " +
      "They must change it and enroll MFA on first login — there is no bypass (SPEC.md §7).",
  );
}

main();
