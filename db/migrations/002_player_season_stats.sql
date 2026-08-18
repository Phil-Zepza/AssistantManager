-- 002: season-aggregate player stats for the LMS "scouting" detail block.
--
-- The /lms detail block (top scorers + xG per team) reads current-season
-- totals, falling back to the most recent PAST season (labelled "last season"
-- in the UI) until real games have been played — the correct behaviour at the
-- very start of a season when every current-season total is still zero.
--
-- Populated by pipeline/run.py step_player_season_stats:
--   * is_current = true  rows come cheaply from bootstrap `elements`
--     (season-to-date totals; refreshed every run, accumulate over the season).
--   * is_current = false rows come from element-summary history_past
--     (one row per player = their most recent past season).
--
-- Team attribution is by the player's CURRENT team_id (players.team_id); a
-- summer transfer therefore counts last season's goals under the new club,
-- which is the standard, acceptable simplification for a scouting glance.

create table if not exists player_season_stats (
  player_id  int not null references players(fpl_id) on delete cascade,
  season     text not null,                 -- e.g. "2026/27" (current) / "2025/26" (last)
  is_current boolean not null default false,
  minutes    int,
  goals      int,
  assists    int,
  xg         real,
  xa         real,
  xgi        real,
  xgc        real,
  points     int,
  updated_at timestamptz default now(),
  primary key (player_id, season)
);

create index if not exists player_season_stats_player_idx
  on player_season_stats (player_id);
