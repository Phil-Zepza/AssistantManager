-- 006: market-when-priced hard switch on model_fixture_probs + pipeline_health.
--
-- The planner's value is the number, and the number should be the MARKET wherever
-- the book has priced a fixture; the Elo+Poisson model is only a fallback for
-- fixtures the market hasn't priced yet (future rounds / outages). To make that a
-- hard switch without losing the model's own view, we split the columns:
--
--   * model_p_home/draw/away  — the model's distribution (canonical; always model).
--   * p_home/draw/away        — the SHOWN distribution every reader/planner uses:
--                               = market when priced, = model otherwise. Written by
--                               the pipeline (step 2 seeds it to the model; the odds
--                               step overwrites it with the market for priced ones).
--   * market_available        — true once the odds step matched a book for a fixture.
--
-- The market_p_* / market_divergence / market_odds_source / market_fetched_at
-- columns already exist (migration 004). Additive + idempotent (add column if not
-- exists). Types match the sibling probability columns (real).

-- ============ 1. NEW COLUMNS (mirrored into db/schema.sql) ============
alter table model_fixture_probs add column if not exists model_p_home    real;
alter table model_fixture_probs add column if not exists model_p_draw    real;
alter table model_fixture_probs add column if not exists model_p_away    real;
alter table model_fixture_probs add column if not exists market_available boolean;

-- ============ 2. BACKFILL (no history lost) ============
-- Existing rows carry the model distribution in p_* (the odds step did not
-- previously overwrite p_*), so seed model_p_* from p_* where not already set.
update model_fixture_probs
   set model_p_home = coalesce(model_p_home, p_home),
       model_p_draw = coalesce(model_p_draw, p_draw),
       model_p_away = coalesce(model_p_away, p_away)
 where model_p_home is null or model_p_draw is null or model_p_away is null;

-- Reflect whether a market distribution was already stored for the fixture, so
-- priced rows read as available immediately (the pipeline resets this each run).
update model_fixture_probs
   set market_available = (market_p_home is not null)
 where market_available is null;

-- ============ 3. PIPELINE HEALTH (fail-loud odds signal) ============
-- Append-only marker log so an odds outage (missing ODDS_API_KEY, failed/empty
-- fetch) leaves a durable, queryable trace even though the run still completes on
-- the model fallback. pipeline/run.py writes an 'error' row (and commits it
-- immediately) on any odds failure and an 'ok' row on success.
create table if not exists pipeline_health (
  id         bigint generated always as identity primary key,
  step       text not null,
  status     text not null,        -- 'ok' | 'error'
  detail     text,
  created_at timestamptz not null default now()
);

create index if not exists pipeline_health_step_created_idx
  on pipeline_health (step, created_at desc);
