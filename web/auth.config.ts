import type { NextAuthConfig } from "next-auth";

// Edge-safe Auth.js config. This file is imported by middleware, so it MUST NOT
// pull in Node-only code (no pg Pool, no adapter, no email provider transport).
// The adapter and the Resend provider are added in auth.ts, which only runs in
// the Node.js runtime (route handlers + server components/actions).
export const authConfig = {
  pages: {
    signIn: "/login",
  },
  // Providers are registered in auth.ts (Resend). Kept empty here to stay
  // edge-safe for middleware.
  providers: [],
  callbacks: {
    // Route protection. Runs in middleware on the edge. Returns true to allow,
    // false to bounce to the signIn page. /api/auth/* is excluded via the
    // middleware matcher, so it is always reachable.
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const { pathname } = nextUrl;

      if (pathname === "/login" || pathname.startsWith("/login/")) {
        // Signed-in users have no business on /login — send them home.
        if (isLoggedIn) return Response.redirect(new URL("/", nextUrl));
        return true;
      }

      // Everything else requires a session.
      return isLoggedIn;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
