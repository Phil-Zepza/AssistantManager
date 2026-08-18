import "server-only";
import { Pool, type PoolClient, type PoolConfig } from "pg";

// Shared pg Pool on DATABASE_URL. SERVER-ONLY: never import this from a client
// component. The `server-only` import above turns any accidental client import
// into a build error. DATABASE_URL is never exposed to the browser.
//
// A single Pool is cached on globalThis so Next.js hot-reloads in dev don't leak
// connections.
const globalForPool = globalThis as unknown as { _pgPool?: Pool };

// Pool tuning for a serverless deploy behind a managed Postgres (Railway).
// Managed proxies silently drop connections that have been idle for a while;
// when the pool later hands out one of those dead sockets a query fails mid-
// flight with `read ECONNRESET`. To avoid that we:
//   - keepAlive: send TCP keepalives so the proxy doesn't consider us idle.
//   - idleTimeoutMillis: retire pooled connections well before the proxy would
//     cull them, so we reconnect on our terms instead of on a dead socket.
//   - connectionTimeoutMillis: fail fast (and let the retry logic below kick in)
//     rather than hanging a request if the DB is briefly unreachable.
//   - allowExitOnIdle: let a frozen serverless function exit cleanly.
const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
  allowExitOnIdle: true,
};

function createPool(): Pool {
  const p = new Pool(poolConfig);
  // CRITICAL: a pooled client can emit 'error' asynchronously (e.g. the DB
  // resets an idle connection). With no listener, Node treats that as an
  // unhandled 'error' event and crashes the whole function. Swallowing it here
  // lets pg discard the dead client; the next query gets a fresh one.
  p.on("error", (err) => {
    console.error("[db] idle client error (recovered):", err);
  });
  return p;
}

export const pool = globalForPool._pgPool ?? createPool();

if (process.env.NODE_ENV !== "production") {
  globalForPool._pgPool = pool;
}

// A dropped/stale connection surfaces as a transient, retriable failure rather
// than a genuine query error. Retrying acquires a fresh connection from the
// pool (pg destroys the broken one), which typically succeeds immediately.
function isRetriableConnError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  const code = e.code ?? "";
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "57P01" || // admin_shutdown (terminating connection …)
    code === "57P03" // cannot_connect_now (DB starting up)
  ) {
    return true;
  }
  const msg = e.message ?? "";
  return (
    msg.includes("Connection terminated") ||
    msg.includes("connection terminated") ||
    msg.includes("Client has encountered a connection error") ||
    msg.includes("timeout exceeded when trying to connect") ||
    msg.includes("ECONNRESET")
  );
}

const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Typed query helper. Pass parameters positionally ($1, $2, …) — NEVER string
// interpolate user input into SQL. Transparently retries on transient
// connection-level failures (stale pooled socket, brief DB blip) so a single
// dropped connection never bubbles up as a 500.
export async function q<T = Record<string, unknown>>(
  sql: string,
  params?: ReadonlyArray<unknown>,
): Promise<T[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await pool.query(sql, params ? [...params] : undefined);
      return res.rows as T[];
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isRetriableConnError(err)) {
        console.error(
          `[db] query failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying:`,
          err,
        );
        await sleep(50 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Run `fn` inside a single transaction (BEGIN/COMMIT, ROLLBACK on throw).
// SERVER-ONLY. Use for multi-statement writes that must be atomic, e.g.
// replacing a user's squad rows for a gameweek. Retries the whole transaction
// on transient connection failures (a dead socket means nothing committed, so
// re-running is safe).
export async function tx<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isRetriableConnError(err)) {
        await sleep(50 * attempt);
        continue;
      }
      throw err;
    }
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      lastErr = err;
      try {
        await client.query("ROLLBACK");
      } catch {
        // Connection is likely already dead; nothing to roll back.
      }
      if (attempt < MAX_ATTEMPTS && isRetriableConnError(err)) {
        console.error(
          `[db] tx failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying:`,
          err,
        );
        await sleep(50 * attempt);
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
  throw lastErr;
}
