-- 006: market-anchored win probability (retire the squad-value transfer modifier).
--
-- The shown win probability (model_fixture_probs.p_*) is now a DECAYING BLEND of
-- the de-vigged bookmaker market and our own Elo+Poisson model:
--     matches_played = (home_completed + away_completed) / 2   -- this season
--     w_market       = max(0, 1 - matches_played / MARKET_HORIZON)   -- MARKET_HORIZON = 8
--     p_shown        = w_market * market + (1 - w_market) * model
-- At GW1 (0 matches played) w_market = 1, so p_shown IS the de-vigged market — the
-- fix for the poorly-calibrated early-season numbers. See pipeline/run.py
-- step_market_blend for the implementation.
--
-- This migration is ADDITIVE and idempotent (add column if not exists):
--   * model_p_* : the raw OWN-MODEL distribution (what p_* used to hold). Backfilled
--                 from the current p_* so existing history is preserved.
--   * market_weight    : the w_market actually used for the shown blend.
--   * market_available : did this fixture get a bookmaker line this run? false ->
--                        p_* is the pure-model fallback (web shows a small flag).
-- The market_p_* / market_divergence / market_odds_source / market_fetched_at
-- columns already exist (migration 004) and are reused; market_divergence is now
-- computed as model_p_* vs market_p_* (our independent model vs the market).
--
-- Also adds pipeline_health: one current-status row per pipeline step, so an odds
-- outage (which now silently degrades the shown numbers to raw model) is
-- impossible to miss. step_market_blend writes status='error' on a missing key or
-- a failed/empty fetch, 'ok' otherwise.

-- ============ 1. NEW COLUMNS on model_fixture_probs (mirrored into schema.sql) ============
alter table model_fixture_probs add column if not exists model_p_home    numeric;
alter table model_fixture_probs add column if not exists model_p_draw     numeric;
alter table model_fixture_probs add column if not exists model_p_away     numeric;
alter table model_fixture_probs add column if not exists market_weight    numeric;
alter table model_fixture_probs add column if not exists market_available boolean;

-- Backfill the own-model record from the current p_* (which, pre-006, held the pure
-- model) so no historical distribution is lost. Only rows not yet backfilled.
update model_fixture_probs
   set model_p_home = p_home,
       model_p_draw = p_draw,
       model_p_away = p_away
 where model_p_home is null
   and p_home is not null;

-- ============ 2. NEW TABLE pipeline_health (mirrored into schema.sql) ============
create table if not exists pipeline_health (
  step        text primary key,       -- e.g. 'odds'
  status      text not null,          -- 'ok' | 'error'
  detail      text,                   -- human-readable summary of the last run
  updated_at  timestamptz not null default now()
);
