// SPEC.md M7 / §6: get_avatar_upload_url(file_name, file_size, content_type)
// — verify auth + active user; validate <= 2MB and image/png|image/jpeg;
// rate bucket avatar_upload:{uid} 5/hour; return a Supabase Storage signed
// upload URL scoped to organizations/{org}/users/{uid}/avatars/{file}.
//
// Runs as a Deno Edge Function (not a Postgres RPC) because minting a
// signed upload URL is a Storage API call, not something SQL can do.
// Uses the service-role key — sanctioned for Edge Function secrets per
// CLAUDE.md's secrets policy, never sent to the client — to read MST_User
// (bypassing RLS is required here since the caller isn't necessarily
// resolvable via their own JWT context alone) and to read/write
// RTL_RateLimitEvent directly. RTL_RateLimitEvent has no RLS grant for
// any client role (M1: "only check_rate_limit() reads/writes this
// table"), and check_rate_limit() itself lives in the `private` Postgres
// schema, which PostgREST doesn't expose (config.toml's `[api] schemas`
// — the same routing gap hit and documented for the M7 pg_cron jobs) — so
// the sliding-window count/insert logic is duplicated here in TypeScript
// rather than calling that helper. Flagged in SPEC.md as a deliberate,
// minimal duplication rather than adding a new public RPC surface just to
// reach a `private` function.

import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};
const RATE_LIMIT_BUCKET_PREFIX = "avatar_upload:";
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message, http_status: status } }, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return errorResponse("UNAUTHORIZED", "You don't have permission to do that.", 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Identify the caller from their own JWT (never trust a client-supplied id).
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
  } = await callerClient.auth.getUser();
  if (!user) {
    return errorResponse("UNAUTHORIZED", "You don't have permission to do that.", 401);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  const { data: profile } = await admin
    .from("MST_User")
    .select("organization_id, is_active")
    .eq("id", user.id)
    .single();
  if (!profile || !profile.is_active) {
    return errorResponse("UNAUTHORIZED", "You don't have permission to do that.", 401);
  }

  let body: { file_name?: unknown; file_size?: unknown; content_type?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse("ERR_VALIDATION", "Please check your input and try again.", 422);
  }

  const { file_name: fileName, file_size: fileSize, content_type: contentType } = body;

  if (typeof fileName !== "string" || fileName.length === 0) {
    return errorResponse("ERR_VALIDATION", "Please check your input and try again.", 422);
  }
  if (typeof fileSize !== "number" || fileSize <= 0 || fileSize > MAX_FILE_SIZE_BYTES) {
    return errorResponse("ERR_VALIDATION", "Please check your input and try again.", 422);
  }
  if (typeof contentType !== "string" || !(contentType in ALLOWED_CONTENT_TYPES)) {
    return errorResponse("ERR_VALIDATION", "Please check your input and try again.", 422);
  }

  // Sliding-window rate limit, same shape as private.check_rate_limit().
  const bucketKey = `${RATE_LIMIT_BUCKET_PREFIX}${user.id}`;
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count } = await admin
    .from("RTL_RateLimitEvent")
    .select("id", { count: "exact", head: true })
    .eq("bucket_key", bucketKey)
    .gt("created_at", windowStart);

  if ((count ?? 0) >= RATE_LIMIT_MAX) {
    return errorResponse("ERR_RATE_LIMITED", "You're doing that too often. Please wait a moment and try again.", 429);
  }

  await admin
    .from("RTL_RateLimitEvent")
    .insert({ organization_id: profile.organization_id, user_id: user.id, bucket_key: bucketKey });

  const extension = ALLOWED_CONTENT_TYPES[contentType];
  const objectPath =
    `organizations/${profile.organization_id}/users/${user.id}/avatars/${crypto.randomUUID()}.${extension}`;

  const { data: signed, error: signError } = await admin.storage
    .from("avatars")
    .createSignedUploadUrl(objectPath);

  if (signError || !signed) {
    return errorResponse("ERR_VALIDATION", "Something went wrong. Please try again.", 500);
  }

  return jsonResponse(
    { path: signed.path, token: signed.token, signed_url: signed.signedUrl },
    200,
  );
});
