import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

// Edge-safe middleware: uses ONLY auth.config (no pg adapter, no email
// transport). The `authorized` callback in auth.config protects every matched
// route; /login is public and /api/auth/* is excluded by the matcher below.
export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  matcher: [
    // Run on all paths except Auth.js endpoints, Next internals and static assets.
    "/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
