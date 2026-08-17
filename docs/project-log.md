# Project Log

Chronological record of setup and fixes, so nothing is lost to session memory.

## 2026-08-16 — Build & deploy of staging
- Scaffolded repo: `db/` (Postgres schema), `pipeline/` (Python: FPL fetch + Elo/Poisson/EP models +
  psycopg upserts + Dockerfile), `web/` (Next.js App Router + Auth.js v5 + pg), `SPEC.md`, `README.md`.
- Stack (Phil's accounts): Railway Postgres + Railway cron pipeline; Vercel Pro web app; Auth.js
  magic-link via Resend. Env model: `main`=prod (later), `staging`=staging (now, Preview on Vercel).

### Fixes made during setup
1. **Railway build failed** (railpack couldn't build the monorepo root). Fix: added `railway.json` at
   repo root pointing the builder at `pipeline/Dockerfile` + cron schedule (`0 6 * * *`,
   restartPolicy NEVER). Set Watch Paths to `pipeline/**` + `railway.json`.
2. **Pipeline NOT NULL crash** (`teams.name` null in step 2 upsert; rolled back the whole run). Fix:
   include name/short_name in the step-2 team update rows. (commit "Fix teams upsert NOT NULL…")
3. **Vercel 404 / 1s build** — Root Directory wasn't `web`, so Next wasn't built. Fix: set Root
   Directory = `web`.
4. **Vercel 500 MIDDLEWARE_INVOCATION_FAILED** — Auth.js edge middleware threw on incomplete config.
   Fix (CC-1): try/catch degrade to /login + `trustHost: true`. Also found env values had been pasted
   into the *description* field not the *value* field, and `AUTH_URL` was missing the `https://` scheme
   (caused `TypeError: Invalid URL`). Corrected the env vars.
5. Staging login works (magic link via Resend). DB seeded: 20 teams, 587 players, 380 fixtures, 380
   fixture probs, GW1 expected points.

### Known data limitation
- A manager's FPL picks are only exposed by the public API AFTER that GW's deadline
  (GW1: Fri 21 Aug 18:30). Pre-deadline `entry/{id}/event/{gw}/picks/` = 404, so `user_squad` is empty
  until then. Mitigation: FPL-1a adds manual squad entry so the app is usable pre-deadline.

## Parallel track — GW1 (separate from the app)
- GW1 deadline Fri 21 Aug 18:30. Phil's squad + LMS pick to be locked in chat before then.
- LMS is strict draw-out; GW1 recommended LMS pick = Arsenal (v Coventry, home).
