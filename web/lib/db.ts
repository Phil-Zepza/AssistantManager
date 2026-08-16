import "server-only";
import { Pool } from "pg";

// Shared pg Pool on DATABASE_URL. SERVER-ONLY: never import this from a client
// component. The `server-only` import above turns any accidental client import
// into a build error. DATABASE_URL is never exposed to the browser.
//
// A single Pool is cached on globalThis so Next.js hot-reloads in dev don't leak
// connections.
const globalForPool = globalThis as unknown as { _pgPool?: Pool };

export const pool =
  globalForPool._pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPool._pgPool = pool;
}

// Typed query helper. Pass parameters positionally ($1, $2, …) — NEVER string
// interpolate user input into SQL.
export async function q<T = Record<string, unknown>>(
  sql: string,
  params?: ReadonlyArray<unknown>,
): Promise<T[]> {
  const res = await pool.query(sql, params ? [...params] : undefined);
  return res.rows as T[];
}
