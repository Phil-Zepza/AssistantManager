import NextAuth from "next-auth";
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
import { authConfig } from "./auth.config";

// Edge-safe middleware: uses ONLY auth.config (no pg adapter, no email
// transport). The `authorized` callback in auth.config protects every matched
// route; /login is public and /api/auth/* is excluded by the matcher below.
const { auth } = NextAuth(authConfig);

// Wrap the Auth.js edge handler so incomplete config (e.g. a missing
// AUTH_SECRET on a mis-provisioned deploy) degrades gracefully instead of
// crashing. On Vercel's edge runtime an exception escaping the middleware
// surfaces as `500 MIDDLEWARE_INVOCATION_FAILED` on EVERY request; here we
// catch it and fall back to the unauthenticated behaviour (redirect to
// /login), so the login page and /api/auth/* stay reachable for recovery.
export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
) {
  try {
    return await auth(request as never, event as never);
  } catch (error) {
    console.error("[middleware] auth failed; degrading to /login:", error);

    const { pathname } = request.nextUrl;
    // Never trap the user on a page they can't recover from: the login page
    // and the Auth.js endpoints must always pass through.
    if (
      pathname === "/login" ||
      pathname.startsWith("/login/") ||
      pathname.startsWith("/api/auth")
    ) {
      return NextResponse.next();
    }

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }
}

export const config = {
  matcher: [
    // Run on all paths except Auth.js endpoints, Next internals and static assets.
    "/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
