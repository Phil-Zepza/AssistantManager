-- db/migrations/005_lms_spread_engine.sql
-- Cross-entry variance ("Spread picks across entries") — competition-level hedge.
--
-- A competition holds multiple entries (lives). Backing the same team in the same
-- round across entries means one freak result can knock them all out together.
-- This migration adds the competition-level spread config, a per-round "use the
-- same team across entries" override, and per-pick provenance so the UI can
-- render forward-plan markers.
--
-- IDEMPOTENT + ADDITIVE (add column if not exists / create table if not exists).
-- Applied by the migration runner (db/migrate.sh), which wraps THIS FILE in a
-- single transaction and records it in schema_migrations on success. Do NOT add
-- BEGIN/COMMIT here — the runner owns the transaction. db/schema.sql remains the
-- structural source of truth: the blocks below are mirrored verbatim into it.

-- ============ 1. lms_competitions: spread config (mirrored into schema.sql) ============
-- spread_mode: 'off' | 'soft' | 'strong'
--   off    — every entry independently takes its own safest (PR A behaviour).
--   soft   — coordinate distinct teams that still clear each entry's confidence_floor.
--   strong — coordinate distinct teams with no floor (hand out next-best however low).
-- spread_floor_soft: the competition-level soft floor (default 0.65, matching the
--   per-entry confidence_floor default). No strong floor column — Strong ignores
--   the floor by design.
alter table lms_competitions
  add column if not exists spread_mode text not null default 'off';
alter table lms_competitions
  add column if not exists spread_floor_soft numeric not null default 0.65;

-- ============ 2. per-round spread override (mirrored into schema.sql) ============
-- A per-round "use the same team across entries" override. force_same=true collapses
-- that round to a single safest team for all alive entries, regardless of mode. This
-- is ALSO the row the engine writes when a Soft round auto-collapses (only one team
-- clears the floor for everyone). PK (competition_id, gw) => one override per round.
create table if not exists lms_competition_spread_overrides (
  competition_id int not null references lms_competitions(id) on delete cascade,
  gw             int not null,
  force_same     boolean not null default true,
  primary key (competition_id, gw)
);

-- ============ 3. lms_entry_picks: pick provenance (mirrored into schema.sql) ============
-- spread_source: 'spread' | 'matched' | null
--   spread  — this pick differs from the entry's pure-safest because of coordination.
--   matched — this pick duplicates a sibling / was collapsed (distinct pool exhausted).
--   null    — no spread effect (off mode, or the coordinated pick == pure-safest).
-- Nullable + no default => existing rows are already NULL (the required "backfill NULL").
alter table lms_entry_picks
  add column if not exists spread_source text;
