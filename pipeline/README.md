# FPL/LMS pipeline

Python data pipeline that pulls the public Fantasy Premier League API, runs the
v1 model, and upserts everything into **Railway Postgres**. See `../SPEC.md` for
the contract and `../db/schema.sql` for the table shapes (the pipeline matches
those exactly).

## Run locally

```bash
cd fpl-lms-assistant
python -m venv .venv && source .venv/bin/activate
pip install -r pipeline/requirements.txt

DATABASE_URL="postgresql://user:pass@host:port/dbname" python pipeline/run.py
```

`DATABASE_URL` is a standard Postgres connection string. Use the Railway Postgres
connection URL (the public/proxy URL when running from your laptop; the private
`.railway.internal` URL when running inside Railway).

Offline model self-check (no network / no DB needed):

```bash
python pipeline/models.py
```

## Environment variables

| Var            | Purpose                                             |
| -------------- | --------------------------------------------------- |
| `DATABASE_URL` | Railway Postgres connection string. Server-side only — never ship to the web client. |

## Deploy on Railway (cron service)

The pipeline runs as a **Railway cron service** built from this repo's Dockerfile.

1. In your Railway project, **New → GitHub Repo** (or **Empty Service → connect
   repo**) and select this repository.
2. In the service's **Settings → Build**:
   - Set **Dockerfile Path** to `pipeline/Dockerfile`.
   - Leave the **Root Directory** at the repo root — the Dockerfile's `COPY`
     paths (`pipeline/...`) assume the build context is the repo root.
3. In **Settings → Variables**, add `DATABASE_URL` and set it to reference your
   Railway Postgres — use a variable reference like
   `${{ Postgres.DATABASE_URL }}` so it stays in sync (the private URL works
   because the service runs inside Railway).
4. In **Settings → Deploy → Cron Schedule**, set a schedule, e.g. `0 6 * * *`
   (daily at 06:00 UTC). Railway starts the container on that schedule; the
   container runs `python run.py` (the Dockerfile `CMD`) and exits, which is the
   expected behaviour for a cron service.

To add a second run (e.g. a pre-deadline refresh), create another service from
the same repo/Dockerfile with a different Cron Schedule. (No GitHub Actions.)

## Modules

| File              | Responsibility                                                          |
| ----------------- | ---------------------------------------------------------------------- |
| `fpl_api.py`      | Pure fetch layer for the FPL API (browser UA; 404-safe picks).         |
| `db.py`           | psycopg v3 layer: `connect()`, batched `upsert(conn, table, rows, conflict_cols)`, `query(conn, sql, params)`, and `replace_recommendation(...)`. |
| `models.py`       | Model v1: Elo, Poisson fixture probs, per-player expected points. Pure functions; tunable constants at the top; runnable self-check in `__main__`. |
| `run.py`          | Entrypoint. Opens one connection and orchestrates the 5 pipeline steps; one summary line each. |
| `Dockerfile`      | python:3.12-slim image for the Railway cron service (build context = repo root). |

## Pipeline steps (`run.py`)

1. Fetch `bootstrap-static` + `fixtures`; upsert `teams`, `players`, `fixtures`,
   `gameweeks` (`num_fixtures` counted per GW; `lms_eligible` is a generated column).
2. Seed Elo from bootstrap strengths, update from finished fixtures, write derived
   `strength_attack`/`strength_defence`/`elo`; compute `model_fixture_probs` for
   upcoming fixtures.
3. Compute `model_player_ep` for the next GW (double GWs summed, blanks = 0).
4. For each `users` row with an `fpl_entry_id`: upsert `user_squad` from their picks
   (skipped gracefully before the deadline) and write `fpl_captain` + `lms_pick`
   rows to `recommendations_log`.
5. All writes are idempotent upserts; `recommendations_log` uses delete-then-insert
   per (user, gw, kind).

## TODO — model refinements

- `models.py`: expected minutes ignores sub appearances (uses a nominal starter
  minute count) — model 1–59' returns.
- `models.py`: DEFCON EP uses a linear `per90 / threshold` ratio, not the true
  per-match CBIT distribution.
- `models.py`: bonus EP is a coarse `bps / starts` proxy — replace with a real
  bps-trend / rank-in-fixture estimate.
- `models.py`: attacking EP folds opponent strength in via `exp_goals_for` — could
  be split into explicit team-attack vs opponent-defence terms.
- `run.py`: transfer recommendation (`fpl_transfer`) and chip advice (`chip`) are
  not yet written — only `fpl_captain` and `lms_pick` are.
- `run.py`: multi-GW EP horizon (`horizon > 1`) not yet computed.
- Elo seeding: promoted teams are only handled via the strength proxy + floor;
  wire in last-season finishing position when available.
