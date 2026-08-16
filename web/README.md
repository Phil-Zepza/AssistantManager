# FPL / LMS Assistant — Web App

Mobile-first Next.js (App Router, TypeScript, Tailwind) front end for the
FPL / Last Man Standing assistant. Auth is **Auth.js (NextAuth v5)** magic-link
over **Resend**; data access is a **direct Postgres (`pg`) layer** against the
same Railway Postgres the Python `pipeline/` writes to. The browser never touches
the database — every query runs server-side and is scoped by the logged-in
user's id.

## Features

- **Magic-link auth** (passwordless email) via Auth.js v5 + the Resend email
  provider + `@auth/pg-adapter`. Middleware protects every route except `/login`
  and `/api/auth/*`.
- **First-login onboarding**: prompts for your FPL team (entry) ID and stores it
  on `users.fpl_entry_id` via a server action.
- **`/` Dashboard**: your squad (`user_squad` → `players` + `model_player_ep`),
  recommended captain (highest projected non-bench player), best transfer
  targets (top projected player per position you don't own), and a chip note.
- **`/lms`**: the next LMS-eligible gameweek's fixtures ranked by outright win
  probability (`model_fixture_probs` → `teams`), your already-used teams
  (`lms_picks`) greyed out, the recommended pick highlighted, and a prominent
  **"Draw = OUT"** reminder.
- **`/history`**: `recommendations_log` entries with outcomes and an accuracy tally.
- **`/settings`**: edit FPL team ID and display name, sign out.

Every page renders sensibly with **zero rows** (empty DB before the first
pipeline run).

## Local development

Requirements: Node 18.17+ (Node 20+ recommended).

```bash
cd web
npm install
cp .env.local.example .env.local   # then fill in the values
npm run dev
```

Open http://localhost:3000. You'll be redirected to `/login`.

### Environment variables

All server-side (none are `NEXT_PUBLIC_*`); `DATABASE_URL` and the Resend key are
never exposed to the browser.

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Railway Postgres connection string — the **same** DB the pipeline uses. On Vercel use the public/pooled Railway URL. |
| `AUTH_SECRET` | Random secret for Auth.js JWT/session signing. Generate with `npx auth secret`. |
| `AUTH_RESEND_KEY` | Resend API key used to send magic-link emails. |
| `AUTH_EMAIL_FROM` | Verified Resend from-address, e.g. `login@yourdomain.com`. |
| `AUTH_URL` | App URL: `http://localhost:3000` locally, your Vercel URL in production. |

### Database

Apply `../db/schema.sql` to your Railway Postgres (psql or the Railway query UI).
It creates the Auth.js adapter tables (`users`, `accounts`, `sessions`,
`verification_token`) — with the `users` table extended by `fpl_entry_id` /
`display_name` — plus all the reference/model/per-user tables. The web app and
the pipeline share this one database via the **same `DATABASE_URL`**.

Note: `users.id` is a `serial` integer; Auth.js session `user.id` is exposed as a
number (see `auth.ts`). All per-user queries filter by this id server-side.

### Resend setup

1. Create a Resend account and **verify a sending domain** (Resend → Domains).
2. Create an **API key** → set it as `AUTH_RESEND_KEY`.
3. Set `AUTH_EMAIL_FROM` to an address on the verified domain
   (e.g. `login@yourdomain.com`). Unverified from-addresses will not send.
4. Locally, magic-link emails are sent for real via Resend, so use an inbox you
   can access.

## Build & type-check

```bash
npm run build
npx tsc --noEmit   # type-check only
```

## Deploy to Vercel (Pro)

1. Push the repo to GitHub.
2. In Vercel, **New Project** → import the repo and set the **Root Directory** to
   `web/` (this app lives in a subfolder).
3. Framework preset: **Next.js** (auto-detected). No build overrides needed.
4. Add all five environment variables above under **Settings → Environment
   Variables** (Production + Preview). Use the **public/pooled** Railway
   `DATABASE_URL` (the same database the pipeline writes to), and set `AUTH_URL`
   to your deployed URL.
5. Deploy. Auth.js callback URLs are served automatically at
   `/api/auth/*` — no external redirect-URL configuration is required.

## Project structure

```
web/
├── auth.config.ts            # edge-safe Auth.js config (pages + authorized callback)
├── auth.ts                   # Auth.js instance: Resend provider + pg adapter + jwt
├── middleware.ts             # route protection via auth.config (edge)
├── app/
│   ├── layout.tsx            # root layout + bottom-tab nav
│   ├── page.tsx              # / dashboard
│   ├── login/page.tsx        # magic-link sign-in
│   ├── actions.ts            # server actions (signIn, save FPL id, settings, signOut)
│   ├── api/auth/[...nextauth]/route.ts  # Auth.js GET/POST handlers
│   ├── lms/page.tsx          # /lms
│   ├── history/page.tsx      # /history
│   └── settings/page.tsx     # /settings
├── components/               # Nav, onboarding, settings form, UI primitives
├── lib/
│   ├── db.ts                 # shared pg Pool + typed q() helper (server-only)
│   ├── types.ts              # row shapes mirroring db/schema.sql
│   ├── queries.ts            # typed, user-scoped data-access helpers
│   ├── gameweek.ts           # current / next-LMS gameweek helpers
│   └── format.ts             # price / EP / % / date formatting
└── types/next-auth.d.ts      # session.user.id typed as number
```

## Notes / limitations

- The app writes only the user's own `users` row (display name, FPL ID) via
  server actions scoped to the session user id. Squads, LMS picks and
  recommendations are written by the pipeline.
- The Auth.js user row is created by `@auth/pg-adapter` on first sign-in.
- `pg` (`lib/db.ts`) is server-only (`import "server-only"`); it is never bundled
  into client components or the edge middleware (middleware imports only
  `auth.config.ts`).
- "Current gameweek" = earliest unfinished `gameweeks` row (falls back to the
  latest on record). The dashboard shows the squad for that GW, falling back to
  the user's most recent stored squad.
- Accuracy in `/history` reads a boolean-ish signal (`correct` / `hit` /
  `won` / `result: "win"`, etc.) from the `outcome` jsonb; adjust to match
  whatever the pipeline writes.
- Depending on your Railway URL you may need SSL. If connections fail, add
  `?sslmode=require` to `DATABASE_URL` (or configure `ssl` on the Pool in
  `lib/db.ts`).
