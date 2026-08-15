import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { decodeJwtClaims } from "@/lib/jwt";

// SPEC §2.2/§7: session -> /login; manager/admin without mfa_enrolled ->
// /mfa/enroll; without aal2 -> /mfa. UX only (CLAUDE.md invariant #1) — RLS
// and the RPC-level require_*_write() guards are the real boundary.
const FULLY_PUBLIC_PREFIXES = [
  "/login",
  "/forgot-password",
  "/reset-password",
  "/invite",
  "/limit-exceeded",
];
const MFA_FLOW_PREFIXES = ["/mfa"];

function matchesPrefix(pathname: string, prefixes: string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (matchesPrefix(pathname, FULLY_PUBLIC_PREFIXES)) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  if (matchesPrefix(pathname, MFA_FLOW_PREFIXES)) {
    return response;
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = session ? decodeJwtClaims(session.access_token) : null;

  if (claims?.user_role === "manager" || claims?.user_role === "admin") {
    const { data: profile } = await supabase
      .from("MST_User")
      .select("mfa_enrolled")
      .eq("id", user.id)
      .single();

    if (!profile?.mfa_enrolled) {
      const url = request.nextUrl.clone();
      url.pathname = "/mfa/enroll";
      return NextResponse.redirect(url);
    }

    if (claims.aal !== "aal2") {
      const url = request.nextUrl.clone();
      url.pathname = "/mfa";
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api).*)"],
};
