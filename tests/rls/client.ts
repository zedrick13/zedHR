import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
