-- 003: per-team Squad Value Index + transfer-modifier components.
--
-- The Elo seed (pipeline/models.py seed_elo) has NO signal for summer transfer
-- activity — a team that upgraded or gutted its squad over the window seeds
-- identically to how it finished last season. The transfer modifier nudges each
-- team's seed by how its Squad Value Index (SVI = sum of the now_cost of its 11
-- most expensive players) compares to what the seed implies, decaying out over
-- the first ~6 completed matches as real results accumulate.
--
-- This table persists the COMPONENTS (not just the final rating) so the movement
-- is explainable and can feed the workstream-5 backtest layer later. One snapshot
-- per (team, gw), written by pipeline/run.py step2_elo_and_fixture_probs and
-- overwritten idempotently on each daily run.
--
-- team_id FKs teams(fpl_id) — teams' PK is fpl_id, NOT id. gw is a plain int
-- (no FK to gameweeks), mirroring the convention used across the schema.

-- ============ 1. NEW TABLE (mirrored into db/schema.sql) ============
create table if not exists team_squad_value_index (
  team_id             int not null references teams(fpl_id),
  gw                  int not null,
  svi                 numeric not null,      -- sum of now_cost of the 11 priciest players (tenths of a million)
  svi_z               numeric not null,      -- SVI z-scored across the 20 teams
  transfer_elo_shock  numeric not null,      -- clamp((svi_z - elo_z) * SCALE, -CAP, +CAP)
  decay_weight        numeric not null,      -- max(0, 1 - completed_matches / DECAY_HORIZON)
  computed_at         timestamptz not null default now(),
  primary key (team_id, gw)
);

create index if not exists team_squad_value_index_gw_idx
  on team_squad_value_index (gw);
