# FPL / LMS Assistant

A lightweight multi-user assistant for Fantasy Premier League (squad, transfers, captaincy, chips)
and a strict "draw = out" Last Man Standing game (weekly outright-winner picks, single-use teams).

Built for Phil + a few friends, on Railway + Vercel Pro:

- **Database** — **Railway Postgres**. Only the Next.js server and the pipeline connect to it;
  the browser never does. Per-user access is scoped in the app layer (no RLS needed).
- **Data pipeline** — **Python**, deployed as a **Railway cron service**. Fetches the FPL API,
  computes team strength (Elo), fixture win probabilities (Poisson), and player expected points,
  then upserts to Postgres.
- **Web app** — **Next.js** on **Vercel Pro**, mobile-first, **Auth.js magic-link login via Resend**.

```
db/        Postgres schema (source of truth, incl. Auth.js adapter tables) — db/schema.sql
pipeline/  Python fetch + models + upsert; Dockerfile for Railway cron
web/       Next.js mobile-first app (Auth.js + pg)
SPEC.md    the build contract both sides follow
```

## Setup checklist (one-time)

### 1. Railway — Postgres
1. New project → add a **Postgres** database.
2. Open its `DATABASE_URL` (Variables tab). Run `db/schema.sql` against it — either
   `psql "$DATABASE_URL" -f db/schema.sql`, or paste it into Railway's query UI.

### 2. Railway — pipeline (cron service)
1. In the same project, **New Service → Deploy from repo** (this repo).
2. Set the service to build with the Dockerfile at `pipeline/Dockerfile` (build context = repo root).
3. Add variable `DATABASE_URL` referencing the Postgres plugin (e.g. `${{ Postgres.DATABASE_URL }}`).
4. Set a **Cron Schedule**, e.g. `0 6 * * *` (daily 06:00 UTC). You can add a second pre-deadline
   run later. Trigger it once manually to populate the DB.

### 3. Resend — magic-link email
1. Create a Resend account, verify a sending domain (or use their onboarding sender for testing),
   and create an **API key**.
2. Note the key (→ `AUTH_RESEND_KEY`) and a verified from-address (→ `AUTH_EMAIL_FROM`).

### 4. Vercel Pro — web app
1. Import the repo, set **Root Directory** to `web`.
2. Environment variables:
   - `DATABASE_URL` — the Railway Postgres URL (use the **public** URL; add `?sslmode=require` if
     connections fail).
   - `AUTH_SECRET` — generate with `npx auth secret` (or any 32+ char random string).
   - `AUTH_RESEND_KEY` — Resend API key.
   - `AUTH_EMAIL_FROM` — verified from-address.
   - `AUTH_URL` — the deployed app URL (e.g. `https://your-app.vercel.app`).
3. Deploy.

### 5. Add users
Each person signs in with their email (magic link), then enters their **FPL team ID** on first
login (Settings). The next pipeline run picks up their team and generates recommendations.
(FPL team ID is in the URL of the "Points" page on fantasy.premierleague.com: `/entry/XXXXXX/...`.)

## Local development
- Pipeline: `DATABASE_URL=... python pipeline/run.py` (see `pipeline/README.md`).
- Web: copy `web/.env.local.example` → `web/.env.local`, fill in, `npm install && npm run dev`
  (see `web/README.md`).

## Notes & known TODOs (v1)
- Models are transparent v1 heuristics (constants at the top of `pipeline/models.py`) — tune over time.
- Pipeline currently writes `fpl_captain` and `lms_pick` recommendations; `fpl_transfer` and `chip`
  advice are stubbed for a later pass.
- `/history` reads an outcome flag from `recommendations_log.outcome` — align its exact JSON key
  between `pipeline/run.py` (when it back-fills outcomes) and `web/lib/queries.ts`.
- Multi-gameweek expected-points horizon (`horizon > 1`) not yet computed.

The strategy/research behind the models and the LMS rules live in the linked Claude Project docs.
