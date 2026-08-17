import "server-only";
import { Pool, type PoolClient } from "pg";

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

// Run `fn` inside a single transaction (BEGIN/COMMIT, ROLLBACK on throw).
// SERVER-ONLY. Use for multi-statement writes that must be atomic, e.g.
// replacing a user's squad rows for a gameweek.
export async function tx<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
