-- db/migrations/007_lms_per_competition_skip.sql
-- Per-competition "skipped rounds" — replace the hardcoded global >= 7 fixtures
-- rule with two per-competition mechanisms.
--
-- Until now a round was excluded from an LMS forward plan iff it had fewer than 7
-- Premier League fixtures (gameweeks.lms_eligible = num_fixtures >= 7). That was
-- ONE organiser's rule for ONE competition, wrongly generalised to every LMS.
-- This migration adds:
--   1. an OPTIONAL per-competition fixture-count threshold
--      (lms_competitions.auto_skip_under_fixtures, default 7, NULL = no rule), and
--   2. a MANUAL per-round skip a user can apply to any round for any reason,
--      reversible (lms_competition_skipped_rounds).
--
-- gameweeks.lms_eligible is LEFT IN PLACE (a harmless "does this GW have 7+ games"
-- fact) but is no longer the authoritative skip gate — the planner now routes every
-- skip decision through a shared per-competition helper (web/lib/lmsPlanner.ts).
--
-- IDEMPOTENT + ADDITIVE (add column if not exists / create table if not exists /
-- create index if not exists). Applied by the migration runner (db/migrate.sh),
-- which wraps THIS FILE in a single transaction and records it in schema_migrations
-- on success. Do NOT add BEGIN/COMMIT here — the runner owns the transaction.
-- db/schema.sql remains the structural source of truth: the blocks below are
-- mirrored verbatim into it.

-- ============ 1. lms_competitions: auto-skip threshold (mirrored into schema.sql) ============
-- auto_skip_under_fixtures: rounds with fewer than this many PL fixtures are
-- auto-skipped for this competition. NULL = no fixture-count rule (a sub-7 round
-- still counts). Default 7 so a freshly-created competition behaves like today.
alter table lms_competitions
  add column if not exists auto_skip_under_fixtures int default 7;

-- Backfill existing rows to 7 so the live EPL LMS competition behaves EXACTLY as
-- it does now (the column default only applies to new rows; existing rows would
-- otherwise be NULL = "no rule", silently un-skipping their sub-7 rounds).
update lms_competitions
   set auto_skip_under_fixtures = 7
 where auto_skip_under_fixtures is null;

-- ============ 2. per-round manual skip (mirrored into schema.sql) ============
-- One row per manually-skipped round. Its presence excludes that round from the
-- competition's forward plan regardless of fixture count; deleting the row
-- restores the round. reason is optional free text surfaced in the UI tile.
-- PK (competition_id, gw) => at most one manual skip per round.
create table if not exists lms_competition_skipped_rounds (
  competition_id int not null references lms_competitions(id) on delete cascade,
  gw             int not null,
  reason         text,
  created_at     timestamptz not null default now(),
  primary key (competition_id, gw)
);

create index if not exists lms_competition_skipped_rounds_competition_idx
  on lms_competition_skipped_rounds (competition_id);
