-- db/migrations/001_lms_rework.sql
-- LMS rework: competitions / entries / per-entry picks + reserves + deadlines.
--
-- IDEMPOTENT. Applied by the migration runner (see db/migrate.sh / `npm run
-- migrate`), which wraps THIS FILE in a single transaction and records it in
-- schema_migrations on success. Do not add BEGIN/COMMIT here — the runner owns
-- the transaction. (It can still be applied by hand for ad-hoc use with:
--     psql "$DATABASE_URL" --single-transaction -f db/migrations/001_lms_rework.sql )
--
-- db/schema.sql remains the structural source of truth: the create-table/index
-- blocks below are mirrored verbatim into schema.sql. The BACKFILL section
-- (part 3) lives ONLY here. This migration does NOT drop/alter the deprecated
-- lms_picks table and NEVER touches the generated column gameweeks.lms_eligible.

-- ============ 1. NEW TABLES (mirrored into db/schema.sql) ============
-- teams PK is fpl_id (NOT id), so team_id FKs -> teams(fpl_id).

create table if not exists lms_competitions (
  id         serial primary key,
  user_id    integer not null references users(id) on delete cascade,
  name       text not null,
  start_gw   int not null default 1,
  notes      text,
  created_at timestamptz default now()
);

create table if not exists lms_competition_deadlines (
  competition_id int not null references lms_competitions(id) on delete cascade,
  gw             int not null,
  deadline       timestamptz,               -- NULL = use computed default (day before first fixture)
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
  is_backfill boolean not null default false,         -- reserved for planner auto-fills; backfill uses false
  unique (entry_id, gw),
  unique (entry_id, team_id)                          -- single-use team per entry per season
);

create table if not exists lms_entry_reserves (
  entry_id int not null references lms_entries(id) on delete cascade,
  team_id  int not null references teams(fpl_id),
  primary key (entry_id, team_id)
);

-- ============ 2. INDEXES (named + IF NOT EXISTS => idempotent) ============
-- NOTE: anonymous `CREATE INDEX ON ...` is NOT idempotent (a second run errors
-- on the auto-named duplicate). These are explicitly named.

create index if not exists idx_lms_entry_picks_entry_id
  on lms_entry_picks (entry_id);

create index if not exists idx_lms_entries_competition_id
  on lms_entries (competition_id);

-- ============ 3. BACKFILL (this file only — NOT in schema.sql) ============
-- Folds legacy lms_picks into one default competition ("My LMS", start_gw 1)
-- per user, each with one entry ("Entry 1"). All steps are set-based and
-- re-runnable (WHERE NOT EXISTS / ON CONFLICT DO NOTHING). No PL/pgSQL, no
-- loops, no RETURNING-into-variables.

-- (a) One default competition per user that has any legacy picks. Keyed on
--     (user_id, name) so a re-run inserts nothing.
insert into lms_competitions (user_id, name, start_gw)
select distinct lp.user_id, 'My LMS', 1
from lms_picks lp
where lp.user_id is not null
  and not exists (
    select 1 from lms_competitions c
    where c.user_id = lp.user_id
      and c.name = 'My LMS'
  );

-- (b) One entry ("Entry 1") per backfill competition. Scoped to competitions
--     whose user actually has legacy picks; guarded by NOT EXISTS on
--     (competition_id, label) for idempotency.
insert into lms_entries (competition_id, label)
select c.id, 'Entry 1'
from lms_competitions c
where c.name = 'My LMS'
  and exists (select 1 from lms_picks lp where lp.user_id = c.user_id)
  and not exists (
    select 1 from lms_entries e
    where e.competition_id = c.id
      and e.label = 'Entry 1'
  );

-- (c) Every legacy pick -> lms_entry_picks, joining lms_picks -> competition
--     (by user_id) -> entry. Old round_gw -> gw, old team_id -> team_id.
--     Status mapping into the new 3-value enum:
--       survived=true  OR result='win'                        -> 'survived'
--       survived=false OR result in (draw,loss,lose,lost)     -> 'eliminated'
--       else                                                  -> 'pending'
--     is_backfill=false: these were REAL user picks, not planner auto-fills.
--
--     Duplicate-team edge: single-use was never enforced historically, so a
--     user may have the same team twice. `order by ... round_gw` inserts the
--     EARLIEST occurrence first; the bare `on conflict do nothing` then drops
--     the later duplicate (unique(entry_id,team_id)) AND makes re-runs no-ops
--     (unique(entry_id,gw)). A bare conflict target (no column list) is used
--     because either of two distinct unique constraints may be violated.
--     `team_id is not null` filter: legacy team_id is NULLABLE but the new
--     column is NOT NULL, so null-team rows are skipped rather than aborting.
insert into lms_entry_picks (entry_id, gw, team_id, result, is_backfill)
select
  e.id,
  lp.round_gw,
  lp.team_id,
  case
    when lp.survived is true  or lower(lp.result) = 'win'                          then 'survived'
    when lp.survived is false or lower(lp.result) in ('draw','loss','lose','lost') then 'eliminated'
    else 'pending'
  end,
  false
from lms_picks lp
join lms_competitions c
  on c.user_id = lp.user_id
 and c.name = 'My LMS'
join lms_entries e
  on e.competition_id = c.id
 and e.label = 'Entry 1'
where lp.team_id is not null
order by lp.user_id, lp.round_gw
on conflict do nothing;

-- (d) Set each entry's status/eliminated_gw from the AUTHORITATIVE lms_picks
--     (not from lms_entry_picks): if a duplicate team was deduped in step (c),
--     the eliminating occurrence might have been the dropped row — reading the
--     source guarantees the elimination signal survives. eliminated_gw = the
--     earliest eliminating round. Guarded by status <> 'out' so re-runs and any
--     later manual/auto-resolve edits are no-ops.
update lms_entries e
set status = 'out',
    eliminated_gw = sub.first_elim_gw
from (
  select c.id as competition_id,
         min(lp.round_gw) as first_elim_gw
  from lms_picks lp
  join lms_competitions c
    on c.user_id = lp.user_id
   and c.name = 'My LMS'
  where lp.survived is false
     or lower(lp.result) in ('draw','loss','lose','lost')
  group by c.id
) sub
where e.competition_id = sub.competition_id
  and e.label = 'Entry 1'
  and e.status <> 'out';
