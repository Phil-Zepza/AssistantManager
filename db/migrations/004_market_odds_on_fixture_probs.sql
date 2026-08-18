-- 004: bookmaker market probabilities on model_fixture_probs (QA calibration).
--
-- Independent sanity signal, NOT an input to the strength model (which stays
-- self-contained by design). pipeline/run.py step_odds_calibration fetches h2h
-- odds once per run from The Odds API, takes the MEDIAN across bookmakers, de-vigs
-- to implied probabilities, and stores them here alongside our model p_*. The web
-- layer flags a fixture when `market_divergence` (measured on the model's favoured
-- win side) exceeds 0.15, so Phil can sanity-check by eye.
--
-- Additive only. The existing p_*/exp_goals_*/computed_at columns are untouched;
-- step_odds_calibration does a partial-column upsert that updates ONLY these
-- market_* columns. All nullable — a run with no ODDS_API_KEY (or an unmatched
-- fixture) simply leaves them NULL. `real` matches the existing p_* columns.

-- ============ 1. NEW COLUMNS (mirrored into db/schema.sql) ============
alter table model_fixture_probs add column if not exists market_p_home      real;
alter table model_fixture_probs add column if not exists market_p_draw      real;
alter table model_fixture_probs add column if not exists market_p_away      real;
alter table model_fixture_probs add column if not exists market_divergence  real;
alter table model_fixture_probs add column if not exists market_odds_source text;
alter table model_fixture_probs add column if not exists market_fetched_at  timestamptz;
