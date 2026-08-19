-- FPL / LMS Assistant — Postgres schema (Railway Postgres + Auth.js)
-- Run in your Railway Postgres (psql or the Railway query UI).
-- Auth is handled by Auth.js (NextAuth) using @auth/pg-adapter; the browser never touches this
-- DB directly — only the Next.js server (and the pipeline) connect. Access is scoped in the
-- app/query layer by the logged-in user's id, so no RLS is required.

-- ============ MIGRATION BOOKKEEPING ============
-- Tracks which ordered files in db/migrations/*.sql have been applied. The
-- migration runner (db/migrate.sh / `npm run migrate`) also creates this if
-- absent; it is declared here so the structural source of truth is complete.
create table if not exists schema_migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
);

-- ============ AUTH.JS (@auth/pg-adapter) TABLES ============
-- Column names/types must match the adapter exactly (note quoted camelCase identifiers).
-- The users table is EXTENDED with app columns (fpl_entry_id, display_name).

create table if not exists users (
  id              serial primary key,
  name            varchar(255),
  email           varchar(255),
  "emailVerified" timestamptz,
  image           text,
  -- app extensions:
  fpl_entry_id    integer,
  display_name    text,
  created_at      timestamptz default now()
);

create table if not exists accounts (
  id                  serial primary key,
  "userId"            integer not null references users(id) on delete cascade,
  type                varchar(255) not null,
  provider            varchar(255) not null,
  "providerAccountId" varchar(255) not null,
  refresh_token       text,
  access_token        text,
  expires_at          bigint,
  id_token            text,
  scope               text,
  session_state       text,
  token_type          text
);

create table if not exists sessions (
  id             serial primary key,
  "userId"       integer not null references users(id) on delete cascade,
  expires        timestamptz not null,
  "sessionToken" varchar(255) not null
);

create table if not exists verification_token (
  identifier text not null,
  expires    timestamptz not null,
  token      text not null,
  primary key (identifier, token)
);

-- ============ REFERENCE / SHARED DATA (written by the pipeline) ============

create table if not exists teams (
  fpl_id            int primary key,
  name              text not null,
  short_name        text not null,
  strength_attack   real,
  strength_defence  real,
  elo               real default 1500,
  updated_at        timestamptz default now()
);

create table if not exists players (
  fpl_id       int primary key,
  web_name     text not null,
  first_name   text,
  second_name  text,
  team_id      int references teams(fpl_id),
  position     text not null,   -- GK / DEF / MID / FWD
  price        int not null,    -- tenths of a million (155 = 15.5m)
  status       text,            -- a / i / d / s / u
  chance_next  int,
  selected_by  real,
  form         real,
  updated_at   timestamptz default now()
);

create table if not exists player_gw_stats (
  player_id int references players(fpl_id),
  gw        int not null,
  minutes   int, goals int, assists int,
  xg real, xa real, xgi real, xgc real,
  defcon real, bps int, points int,
  primary key (player_id, gw)
);

-- Season-aggregate player stats for the /lms scouting detail block. See
-- db/migrations/002_player_season_stats.sql for the full rationale. is_current
-- rows come from the bootstrap; past-season rows from element-summary
-- history_past. The block prefers current-season totals, falling back to the
-- most recent past season (labelled "last season") until games are played.
create table if not exists player_season_stats (
  player_id  int not null references players(fpl_id) on delete cascade,
  season     text not null,
  is_current boolean not null default false,
  minutes    int, goals int, assists int,
  xg real, xa real, xgi real, xgc real,
  points     int,
  updated_at timestamptz default now(),
  primary key (player_id, season)
);

create table if not exists fixtures (
  fpl_id      int primary key,
  gw          int,
  home_team   int references teams(fpl_id),
  away_team   int references teams(fpl_id),
  kickoff     timestamptz,
  home_diff   int, away_diff int,
  home_score  int, away_score int,
  finished    boolean default false
);

create table if not exists model_player_ep (
  player_id       int references players(fpl_id),
  gw              int not null,
  horizon         int not null default 1,
  expected_points real,
  computed_at     timestamptz default now(),
  primary key (player_id, gw, horizon)
);

create table if not exists model_fixture_probs (
  fixture_id  int references fixtures(fpl_id) primary key,
  -- p_* is the SHOWN distribution: a decaying blend of market + own model. See 006.
  p_home real, p_draw real, p_away real,
  exp_goals_h real, exp_goals_a real,
  computed_at timestamptz default now(),
  -- our own Elo+Poisson distribution (what p_* held pre-006) — see 006 migration.
  model_p_home numeric,
  model_p_draw numeric,
  model_p_away numeric,
  -- market-anchored blend bookkeeping — see 006 migration.
  market_weight    numeric,   -- w_market actually used for the shown blend
  market_available boolean,   -- false -> p_* is the pure-model fallback (web flags it)
  -- de-vigged bookmaker market (median across UK books) — see 004 migration.
  -- market_divergence is model_p_* vs market_p_* on the favoured win side (see 006).
  market_p_home      real,
  market_p_draw      real,
  market_p_away      real,
  market_divergence  real,
  market_odds_source text,
  market_fetched_at  timestamptz
);

-- One current-status row per pipeline step — see 006 migration. Lets an odds
-- outage (which degrades the shown win prob to the raw, poorly-calibrated model)
-- be surfaced instead of silently shipped. pipeline/run.py step_market_blend
-- writes status='error' on a missing key or failed/empty fetch, 'ok' otherwise.
create table if not exists pipeline_health (
  step        text primary key,
  status      text not null,
  detail      text,
  updated_at  timestamptz not null default now()
);

-- Per-team Squad Value Index + transfer-modifier components — see 003 migration.
-- Persists WHY a seed Elo moved (squad value vs seed) so it's explainable and can
-- feed the workstream-5 backtest. team_id -> teams(fpl_id); gw is a plain int.
create table if not exists team_squad_value_index (
  team_id             int not null references teams(fpl_id),
  gw                  int not null,
  svi                 numeric not null,
  svi_z               numeric not null,
  transfer_elo_shock  numeric not null,
  decay_weight        numeric not null,
  computed_at         timestamptz not null default now(),
  primary key (team_id, gw)
);

create index if not exists team_squad_value_index_gw_idx
  on team_squad_value_index (gw);

create table if not exists gameweeks (
  gw           int primary key,
  deadline     timestamptz,
  num_fixtures int,
  lms_eligible boolean generated always as (num_fixtures >= 7) stored,
  finished     boolean default false
);

-- ============ PER-USER DOMAIN DATA (scoped in app layer by user id) ============

create table if not exists user_squad (
  user_id    integer references users(id) on delete cascade,
  gw         int not null,
  player_id  int references players(fpl_id),
  is_captain boolean default false,
  is_vice    boolean default false,
  on_bench   boolean default false,
  primary key (user_id, gw, player_id)
);

-- DEPRECATED (kept for back-compat + as the 001 migration's backfill source).
-- Superseded by the LMS-rework tables below (lms_competitions / lms_entries /
-- lms_entry_picks). New writes go to lms_entry_picks; the pipeline auto-resolve
-- step settles lms_entry_picks (NOT this table). See db/migrations/001_lms_rework.sql.
create table if not exists lms_picks (
  user_id    integer references users(id) on delete cascade,
  round_gw   int not null,
  team_id    int references teams(fpl_id),
  result     text,            -- win / draw / loss / pending
  survived   boolean,
  created_at timestamptz default now(),
  primary key (user_id, round_gw)
);

-- ---- LMS rework (mirrors db/migrations/001_lms_rework.sql; structure only) ----
-- Competitions -> Entries -> per-entry picks. Each entry is an independent run
-- (own used-teams, status, reserve strategy, confidence floor). team_id FKs are
-- to teams(fpl_id). Backfill of legacy lms_picks lives ONLY in the migration.

create table if not exists lms_competitions (
  id                serial primary key,
  user_id           integer not null references users(id) on delete cascade,
  name              text not null,
  start_gw          int not null default 1,
  notes             text,
  created_at        timestamptz default now(),
  -- Cross-entry variance ("Spread picks across entries"). See db/migrations/005.
  spread_mode       text not null default 'off',      -- 'off' | 'soft' | 'strong'
  spread_floor_soft numeric not null default 0.65      -- Soft floor (Strong ignores it)
);

create table if not exists lms_competition_deadlines (
  competition_id int not null references lms_competitions(id) on delete cascade,
  gw             int not null,
  deadline       timestamptz,               -- NULL = use computed default (day before first fixture)
  primary key (competition_id, gw)
);

-- Per-round "use the same team across entries" override. force_same=true collapses
-- the round to one safest team for all alive entries (any mode); also the row the
-- engine records when a Soft round auto-collapses. See db/migrations/005.
create table if not exists lms_competition_spread_overrides (
  competition_id int not null references lms_competitions(id) on delete cascade,
  gw             int not null,
  force_same     boolean not null default true,
  primary key (competition_id, gw)
);

create table if not exists lms_entries (
  id               serial primary key,
  competition_id   int not null references lms_competitions(id) on delete cascade,
  label            text not null,
  status           text not null default 'alive',    -- 'alive' | 'out'
  eliminated_gw    int,
  reserve_strategy text not null default 'smart',     -- 'safest' | 'manual' | 'smart'
  confidence_floor numeric not null default 0.65
);

create table if not exists lms_entry_picks (
  id          serial primary key,
  entry_id    int not null references lms_entries(id) on delete cascade,
  gw          int not null,
  team_id     int not null references teams(fpl_id),
  result      text not null default 'pending',        -- 'pending' | 'survived' | 'eliminated'
  is_backfill boolean not null default false,
  spread_source text,                                 -- 'spread' | 'matched' | null (see migration 005)
  unique (entry_id, gw),
  unique (entry_id, team_id)                          -- single-use team per entry per season
);

create table if not exists lms_entry_reserves (
  entry_id int not null references lms_entries(id) on delete cascade,
  team_id  int not null references teams(fpl_id),
  primary key (entry_id, team_id)
);

create index if not exists idx_lms_entry_picks_entry_id  on lms_entry_picks (entry_id);
create index if not exists idx_lms_entries_competition_id on lms_entries (competition_id);

create table if not exists recommendations_log (
  id         bigint generated always as identity primary key,
  user_id    integer references users(id) on delete cascade,
  gw         int not null,
  kind       text not null,   -- 'fpl_xi' | 'fpl_transfer' | 'fpl_captain' | 'lms_pick' | 'chip'
  payload    jsonb,
  outcome    jsonb,
  created_at timestamptz default now()
);
