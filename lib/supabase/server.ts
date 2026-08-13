import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          // Route Handlers/Server Actions can write cookies; plain Server
          // Components cannot and will throw here — safe to ignore since
          // middleware refreshes the session on the next request.
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // no-op: called from a Server Component
          }
        },
      },
    },
  );
}
