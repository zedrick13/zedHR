import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as OTPAuth from "otpauth";
import type { Database } from "@/lib/database.types";

// Standard local Supabase dev defaults (published in Supabase's own docs,
// identical for every fresh `supabase init` — not secrets). Real env vars,
// if set, always win.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

// Each test creates many independent, concurrently-live clients in the same
// Node process. Without a unique storageKey per client, supabase-js's
// default in-memory storage adapter (no real localStorage in Node) shares
// one key across all of them, so a later signInAs() clobbers an earlier
// client's session out from under it — surfaced as "Multiple GoTrueClient
// instances detected" and, worse, silently wrong-user test results.
function uniqueStorageKey(): string {
  return `sb-test-${randomUUID()}-auth-token`;
}

export function adminClient(): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, storageKey: uniqueStorageKey() },
  });
}

export function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, storageKey: uniqueStorageKey() },
  });
}

export async function signInAs(
  email: string,
  password: string,
): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, storageKey: uniqueStorageKey() },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`signInAs(${email}) failed: ${error.message}`);
  }
  return client;
}

// The generated types don't model nullable scalar RPC args (some genuinely
// are null at runtime — e.g. geo_status "denied" carries null lat/lng), so
// a direct client.rpc() call doesn't typecheck for those cases. This
// bypasses that the same way lib/callRpc.ts does — real app code already
// goes through callRpc, so this friction is test-only. Typed <T> so callers
// don't need a cast at every use site.
export async function rpc<T = unknown>(
  client: SupabaseClient<Database>,
  fn: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  const result = await client.rpc(fn as never, args as never);
  return result as unknown as { data: T | null; error: { message: string } | null };
}

/**
 * Enrolls TOTP and verifies it, granting aal2 on the given client's current
 * session — needed for any RPC gated by require_admin_write() /
 * require_manager_or_admin_write() (SPEC §3.2 "MFA gate").
 */
export async function grantAal2(client: SupabaseClient<Database>) {
  const { data: enrolled, error: enrollError } = await client.auth.mfa.enroll({
    factorType: "totp",
  });
  if (enrollError || !enrolled) throw new Error(`enroll failed: ${enrollError?.message}`);

  const { data: challenge, error: challengeError } = await client.auth.mfa.challenge({
    factorId: enrolled.id,
  });
  if (challengeError || !challenge) throw new Error(`challenge failed: ${challengeError?.message}`);

  const totp = new OTPAuth.TOTP({ secret: enrolled.totp.secret, digits: 6, period: 30 });

  const { data: verified, error: verifyError } = await client.auth.mfa.verify({
    factorId: enrolled.id,
    challengeId: challenge.id,
    code: totp.generate(),
  });
  if (verifyError || !verified) throw new Error(`verify failed: ${verifyError?.message}`);

  return verified;
}

export async function isSupabaseReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: ANON_KEY },
    });
    return res.ok;
  } catch {
    return false;
  }
}
