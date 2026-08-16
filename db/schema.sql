-- FPL / LMS Assistant — Postgres schema (Railway Postgres + Auth.js)
-- Run in your Railway Postgres (psql or the Railway query UI).
-- Auth is handled by Auth.js (NextAuth) using @auth/pg-adapter; the browser never touches this
-- DB directly — only the Next.js server (and the pipeline) connect. Access is scoped in the
-- app/query layer by the logged-in user's id, so no RLS is required.

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
  p_home real, p_draw real, p_away real,
  exp_goals_h real, exp_goals_a real,
  computed_at timestamptz default now()
);

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

create table if not exists lms_picks (
  user_id    integer references users(id) on delete cascade,
  round_gw   int not null,
  team_id    int references teams(fpl_id),
  result     text,            -- win / draw / loss / pending
  survived   boolean,
  created_at timestamptz default now(),
  primary key (user_id, round_gw)
);

create table if not exists recommendations_log (
  id         bigint generated always as identity primary key,
  user_id    integer references users(id) on delete cascade,
  gw         int not null,
  kind       text not null,   -- 'fpl_xi' | 'fpl_transfer' | 'fpl_captain' | 'lms_pick' | 'chip'
  payload    jsonb,
  outcome    jsonb,
  created_at timestamptz default now()
);
