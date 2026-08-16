import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import PostgresAdapter from "@auth/pg-adapter";
import { authConfig } from "./auth.config";
import { pool } from "@/lib/db";

// Full Auth.js instance for the Node.js runtime (route handlers, server
// components, server actions). This file is NEVER imported by middleware, so it
// is safe to use the pg adapter + Pool here.
//
// - Resend email (magic-link) provider.
// - @auth/pg-adapter on the shared Railway Postgres Pool: it persists users +
//   verification tokens (adapter tables live in db/schema.sql).
// - JWT session strategy so middleware can authorize on the edge without a DB
//   round-trip, while the adapter still stores users/verification tokens.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PostgresAdapter(pool),
  session: { strategy: "jwt" },
  providers: [
    Resend({
      apiKey: process.env.AUTH_RESEND_KEY,
      from: process.env.AUTH_EMAIL_FROM,
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Expose the numeric user id (users.id, a serial integer) on the session.
    async session({ session, token }) {
      if (session.user && token.sub) {
        // The callback param intersects our Session (id: number) with the
        // adapter user (id: string), so the assignment target collapses to
        // `never`; cast for the write. Read-side `session.user.id` stays number.
        (session.user as { id: number }).id = Number(token.sub);
      }
      return session;
    },
  },
});
