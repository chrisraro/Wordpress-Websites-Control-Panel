import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// This middleware refreshes the Supabase session and redirects anonymous
// visitors. It performs NO authorization, and must never be given any.
// Next.js CVE-2025-29927 let a crafted x-middleware-subrequest header convince
// the framework middleware had already run, skipping it entirely — every app
// whose only gate lived here was fully exposed. Middleware is an optimisation
// the framework can short-circuit, not a security boundary. Authorization
// belongs in each page, server action and route handler. See
// docs/superpowers/specs/2026-08-29-phase9a-authorization-design.md §4.2.

const PUBLIC_EXACT = ["/login"];
const PUBLIC_PREFIXES = ["/r/", "/api/cron/", "/api/webhooks/"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_EXACT.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));

  if (isPublic && pathname !== "/login") {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { data } = await supabase.auth.getUser();

  if (!data.user && !isPublic) {
    const redirect = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }
  if (data.user && pathname === "/login") {
    const redirect = NextResponse.redirect(new URL("/dashboard", request.url));
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }
  return response;
}

export const config = {
  // `webmanifest` is not optional here: the App Router serves the PWA manifest
  // at /manifest.webmanifest, and without this exclusion the auth middleware
  // 307s it to /login for signed-out visitors, which breaks install prompts and
  // icon metadata. icon.png and apple-icon.png escape only because they happen
  // to end in .png — do not rely on that for a future metadata route.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|ico|webmanifest)$).*)"],
};
