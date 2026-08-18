# Database

Postgres on Railway. The schema is applied **by hand** — there is no ORM. Two files
define everything:

| File | Role |
| --- | --- |
| `db/schema.sql` | **Structural source of truth** — the full current shape of every table/index. Applied once to a fresh database. |
| `db/migrations/NNN_*.sql` | **Ordered deltas** applied after the baseline — schema changes plus any data backfills. Each is recorded in `schema_migrations` once applied. |

`db/migrate.sh` is the runner that applies pending migrations and tracks them.

## The migration runner

```bash
# from web/ (uses DATABASE_URL from the environment)
DATABASE_URL=postgres://… npm run migrate

# or directly
DATABASE_URL=postgres://… sh db/migrate.sh
```

What it does, idempotently:

1. ensures the `schema_migrations` table (`filename`, `applied_at`),
2. applies every `db/migrations/*.sql` **not yet recorded**, in filename order, each
   wrapped in **one transaction** (`--single-transaction`) with `ON_ERROR_STOP`,
   recording the filename in the **same** transaction so apply-and-record is atomic,
3. is a **no-op** when nothing is pending (safe to run on every deploy),
4. prints the target host/db (via `\conninfo`, **never** the password) before applying.

Requires `psql` on `PATH` (already how `db/schema.sql` is applied). Exits non-zero on any
failure so a deploy step can gate on it.

## Writing a migration

- Name it `NNN_short_description.sql` with the next zero-padded number.
- **Do not** add `BEGIN;` / `COMMIT;` — the runner wraps each file in one transaction.
- Keep it **idempotent** (`create table if not exists`, `... if not exists`, guarded
  `insert … where not exists` / `on conflict do nothing`) so a re-run is harmless.
- **Never** drop or destructively alter an existing table.
- Avoid statements that cannot run inside a transaction block (e.g. `CREATE INDEX
  CONCURRENTLY`, `ALTER TYPE … ADD VALUE`). If you need one, keep it in its own migration
  and note the exception.
- If the change is structural, mirror the final table/index shape into `db/schema.sql`
  too, so a fresh database built from the baseline matches.

## Go-live: standing up a fresh production database

There is no prod DB yet. When one is created, run these **once**, in order, against the
new `DATABASE_URL`:

```bash
# 1. baseline structure
psql "$DATABASE_URL" -f db/schema.sql

# 2. apply + record migrations (idempotent; DDL already in the baseline is a no-op,
#    data backfills no-op on an empty DB), leaving schema_migrations populated
DATABASE_URL="$DATABASE_URL" npm run migrate   # or: sh db/migrate.sh
```

From then on the runner runs automatically on every Railway deploy (see below), so the
DB can never drift behind the deployed code again.

## How it's wired into deploy

The runner is Railway's **pre-deploy command** (`railway.json` → `deploy.preDeployCommand:
"sh db/migrate.sh"`), and `pipeline/Dockerfile` installs `postgresql-client` and copies
`db/` into the image. Railway runs it against the service `DATABASE_URL` **before** the new
deployment (the pipeline cron) goes live.

Railway is the right place — **not** the Vercel build — because:

- Railway owns the database and holds the authoritative `DATABASE_URL`; the migration runs
  in the same trust boundary as the DB.
- A Vercel **build** step runs on every preview/PR build and shouldn't mutate a shared DB
  (which DB would a preview migrate?); builds also aren't guaranteed DB network access.
- A pre-deploy hook runs **once per deploy, before traffic**, and a non-zero exit aborts
  the deploy — exactly the gate we want.

Ordering note: the web app (Vercel) and the pipeline (Railway) deploy independently. At a
release that includes a schema change, let the Railway pre-deploy migration finish before
relying on the new schema from the web app.

## Reconciling an existing database

A database that already had a migration applied by hand (e.g. staging got
`001_lms_rework.sql` before this runner existed) must have that migration **recorded** so
the runner doesn't re-run it:

```sql
create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
insert into schema_migrations (filename) values ('001_lms_rework.sql')
  on conflict (filename) do nothing;
```

(Only migration files are tracked — the `db/schema.sql` baseline needs no row.)
