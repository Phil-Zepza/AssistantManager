# BUILD SPEC / CONTRACT — FPL/LMS Assistant (Railway + Vercel Pro + Auth.js)

Shared contract. The Python pipeline and the Next.js app both build against `db/schema.sql`.
Do not change table/column names without updating both sides.

## Stack
- **DB:** Railway Postgres. Both the Next.js server and the pipeline connect via `DATABASE_URL`.
  The browser NEVER connects to the DB directly — access is scoped in the app/query layer by the
  logged-in user's id. No RLS.
- **Pipeline:** Python, deployed on **Railway as a cron service** (full network → FPL API).
- **Web:** Next.js (App Router, TS, Tailwind) on **Vercel Pro**.
- **Auth:** **Auth.js (NextAuth v5)** Email (magic-link) provider via **Resend**, with
  **@auth/pg-adapter** on the same Railway Postgres (adapter tables are in `db/schema.sql`).

## Environment variables
Pipeline (Railway service variables):
- `DATABASE_URL`  — Railway Postgres connection string.
Web (Vercel env vars):
- `DATABASE_URL`         — same Railway Postgres (use the public/pooled URL for Vercel).
- `AUTH_SECRET`          — random secret for Auth.js.
- `AUTH_RESEND_KEY`      — Resend API key (magic-link email).
- `AUTH_EMAIL_FROM`      — verified from-address for Resend (e.g. login@yourdomain).
- `AUTH_URL`             — deployed app URL (e.g. https://your-app.vercel.app).

## FPL API (public, unauthenticated) — endpoints the pipeline uses
- `bootstrap-static/` -> `.teams[]` (id, name, short_name, strength_attack_home/away,
  strength_defence_home/away, strength_overall_home/away), `.elements[]` (id, web_name, first_name,
  second_name, team, element_type[1=GK,2=DEF,3=MID,4=FWD], now_cost, status,
  chance_of_playing_next_round, selected_by_percent, form, expected_goals, expected_assists,
  expected_goal_involvements, expected_goals_conceded, per-90 variants, starts,
  defensive_contribution), `.events[]` (id, deadline_time, finished, is_current, is_next).
- `fixtures/` and `fixtures/?event=N`: id, event, team_h, team_a, kickoff_time,
  team_h_difficulty, team_a_difficulty, team_h_score, team_a_score, finished.
- `element-summary/{player_id}/` -> history[], history_past[].
- `entry/{entry_id}/`, `entry/{entry_id}/history/`, `entry/{entry_id}/event/{gw}/picks/`
  (picks 404 before that GW's deadline — handle gracefully).
Use a browser-like User-Agent. Prices `now_cost` are in tenths (155 = 15.5m).

## Model v1 (UNCHANGED — transparent heuristics; keep constants at top of models.py)
### Team strength (Elo) -> fixture win probabilities
- Seed Elo 1500 adjusted by bootstrap strength tiers; promoted teams ~1420. Store `teams.elo`.
- Update Elo after finished fixtures (K≈20, home advantage ≈ +60 Elo, scale by goal difference).
- Per upcoming fixture: derive expected goals home/away from attack/defence strength + home
  advantage, build a Poisson score matrix (0..8) → `p_home`, `p_draw`, `p_away`, `exp_goals_h`,
  `exp_goals_a` → `model_fixture_probs`. Drives the LMS ranking.
### Expected FPL points per player (this GW; horizon extensible)
Minutes-weighted sum of appearance, attacking (xG90*pos_pts + xA90*3, opponent-adjusted),
clean-sheet (GK/DEF 4, MID 1 * P(CS)), DEFCON (+2 proxy), small bonus estimate → `model_player_ep`.

## Pipeline — what it must do (entrypoint `pipeline/run.py`)
1. Fetch bootstrap-static + fixtures. Upsert `teams`, `players`, `fixtures`, `gameweeks`
   (num_fixtures = fixtures in GW; lms_eligible is generated).
2. Update Elo from finished fixtures; compute `model_fixture_probs` for upcoming GW(s).
3. Compute `model_player_ep` for the next GW.
4. For each row in `users` with `fpl_entry_id`: fetch entry + picks (if past deadline) → upsert
   `user_squad`; write recommendations to `recommendations_log`.
5. Idempotent upserts via `INSERT ... ON CONFLICT ... DO UPDATE`. One summary line per step.
Data access: **psycopg (v3) using `DATABASE_URL`** — a small `db.py` with `upsert(conn, table,
rows, conflict_cols)` and `query(...)`. `requirements.txt`: `psycopg[binary]`, `requests`.
Deploy: `pipeline/Dockerfile` (python:3.12-slim, install reqs, `CMD python run.py`) and a note in
`pipeline/README.md` on setting the Railway service to a **Cron Schedule** (e.g. daily 06:00 UTC)
with `DATABASE_URL` set. (No GitHub Actions.)

## Web — what it must do (`web/`)
- Next.js App Router, TS, Tailwind, mobile-first, clean minimal UI, bottom-tab nav on mobile.
- **Auth.js v5** (`next-auth@beta`) with the **Email provider via Resend** and **@auth/pg-adapter**
  (`pg` Pool on `DATABASE_URL`). `auth.ts` config, `/api/auth/[...nextauth]` route, middleware
  protecting all routes except `/login` and `/api/auth/*`. `/login` calls `signIn("resend"/"email")`.
- **Data layer** (`web/lib/db.ts` + `web/lib/queries.ts`): a `pg` Pool; every per-user query takes
  the session user id (from `auth()`), NOT trusting any client input. Reference-table reads are open
  to any signed-in user. Never expose `DATABASE_URL` to the client.
- On first login, if `users.fpl_entry_id` is null, prompt for FPL team ID → update it.
- Pages (identical UX to before):
  - `/` Dashboard: user squad (user_squad ⋈ players ⋈ model_player_ep, current GW), recommended
    captain (highest EP starter), best-transfer panel (top EP unowned players by position), chip note.
  - `/lms`: next lms_eligible GW fixtures ranked by outright win prob (model_fixture_probs ⋈ teams),
    used teams (lms_picks) greyed/disabled, recommended pick highlighted, prominent "Draw = OUT".
  - `/history`: recommendations_log with outcomes + accuracy tally.
  - `/settings`: edit fpl_entry_id + display_name, sign out.
- Every page renders sensibly with zero rows (DB empty until first pipeline run).
- Provide `web/README.md` (local dev, env vars, Vercel deploy with root dir `web`) and
  `web/.env.local.example`.
