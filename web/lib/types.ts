// Typed shapes mirroring db/schema.sql EXACTLY (table + column names).
// These are the row shapes returned by the pg data layer (lib/queries.ts).

export type Position = "GK" | "DEF" | "MID" | "FWD";

export interface Team {
  fpl_id: number;
  name: string;
  short_name: string;
  strength_attack: number | null;
  strength_defence: number | null;
  elo: number | null;
  updated_at: string;
}

export interface Player {
  fpl_id: number;
  web_name: string;
  first_name: string | null;
  second_name: string | null;
  team_id: number | null;
  position: Position;
  price: number; // tenths of a million
  status: string | null;
  chance_next: number | null;
  selected_by: number | null;
  form: number | null;
  updated_at: string;
}

export interface Fixture {
  fpl_id: number;
  gw: number | null;
  home_team: number | null;
  away_team: number | null;
  kickoff: string | null;
  home_diff: number | null;
  away_diff: number | null;
  home_score: number | null;
  away_score: number | null;
  finished: boolean;
}

export interface ModelPlayerEp {
  player_id: number;
  gw: number;
  horizon: number;
  expected_points: number | null;
  computed_at: string;
}

export interface ModelFixtureProbs {
  fixture_id: number;
  // Shown distribution: = market when the fixture is priced, = model otherwise
  // (market-when-priced hard switch). Every reader/planner uses p_*. See 006.
  p_home: number | null;
  p_draw: number | null;
  p_away: number | null;
  // The model's own canonical distribution (always the model, never the market).
  model_p_home: number | null;
  model_p_draw: number | null;
  model_p_away: number | null;
  exp_goals_h: number | null;
  exp_goals_a: number | null;
  computed_at: string;
  // De-vigged bookmaker market. `market_available` is true once the odds step
  // matched a book for this fixture; null/false means the shown p_* is the model.
  market_available: boolean | null;
  market_p_home: number | null;
  market_p_draw: number | null;
  market_p_away: number | null;
  market_divergence: number | null;
  market_odds_source: string | null;
  market_fetched_at: string | null;
}

export interface Gameweek {
  gw: number;
  deadline: string | null;
  num_fixtures: number | null;
  lms_eligible: boolean;
  finished: boolean;
}

export interface User {
  id: number;
  name: string | null;
  email: string | null;
  display_name: string | null;
  fpl_entry_id: number | null;
  created_at: string;
}

export interface UserSquadRow {
  user_id: number;
  gw: number;
  player_id: number;
  is_captain: boolean;
  is_vice: boolean;
  on_bench: boolean;
}

export interface LmsPick {
  user_id: number;
  round_gw: number;
  team_id: number | null;
  result: string | null; // win / draw / loss / pending
  survived: boolean | null;
  created_at: string;
}

export type RecommendationKind =
  | "fpl_xi"
  | "fpl_transfer"
  | "fpl_captain"
  | "lms_pick"
  | "chip";

export interface RecommendationLog {
  id: number;
  user_id: number;
  gw: number;
  kind: RecommendationKind;
  payload: Record<string, unknown> | null;
  outcome: Record<string, unknown> | null;
  created_at: string;
}

// ---- Composed view models used by pages ----

export interface SquadEntry {
  player: Player;
  team: Team | null;
  expected_points: number | null;
  is_captain: boolean;
  is_vice: boolean;
  on_bench: boolean;
}

// Next fixture for a player's team, with a difficulty indicator.
export interface NextFixtureInfo {
  fixture_id: number;
  gw: number | null;
  is_home: boolean;
  opponent: Team | null;
  // FPL fixture-difficulty rating (1 easy … 5 hard) faced by this player's team.
  difficulty: number | null;
  // Optional model win probability for this player's team in the fixture.
  win_prob: number | null;
}

// A selectable player in the manual squad picker: player + club + projection +
// next fixture. Reference/model data (open to any signed-in user).
export interface PickPoolEntry {
  player: Player;
  team: Team | null;
  expected_points: number | null;
  next_fixture: NextFixtureInfo | null;
}

// One row of an edited squad, as sent from the client to the save action.
// Mirrors the persistable columns of user_squad exactly (no bench-order column
// exists in the schema, so bench order is a live editor helper only — it is not
// persisted).
export interface SquadSelection {
  playerId: number;
  onBench: boolean;
  isCaptain: boolean;
  isVice: boolean;
}

export interface TransferSuggestion {
  position: Position;
  player: Player;
  team: Team | null;
  expected_points: number | null;
}

export interface LmsFixtureOption {
  fixture: Fixture;
  homeTeam: Team | null;
  awayTeam: Team | null;
  probs: ModelFixtureProbs | null;
  // best single team to back from this fixture
  pickTeam: Team | null;
  pickWinProb: number | null;
  pickIsHome: boolean;
  alreadyUsed: boolean;
}

// ---- Profile view models ----

// One row of the season-history table (Profile). Derived from the FPL
// entry/{id}/history/ endpoint (past seasons + the in-progress season).
export interface SeasonHistoryRow {
  season: string; // e.g. "2024/25"
  overallRank: number | null; // final (past) or latest (current) overall rank
  points: number | null; // total points that season
  isCurrent: boolean; // the in-progress season, tagged in the UI
}

// One LMS round pick with a derived survival status, for the profile card.
// (Distinct from the /lms canvas `LmsEntry` below, which models a whole run.)
export type LmsStatus = "alive" | "out" | "pending";

export interface LmsRoundEntry {
  round_gw: number;
  teamShort: string | null; // backed team short name (null if unknown)
  result: string | null; // win / draw / loss / pending (raw)
  status: LmsStatus; // derived: strict "draw = out"
}

export interface LmsSummary {
  entries: number; // number of round picks on record
  alive: boolean; // still in it (no round lost/drawn yet)
  rounds: LmsRoundEntry[];
}

// ---- LMS canvas view models (/lms) ----

// One team already spent by an entry in a past round.
export interface LmsEntryPick {
  roundGw: number;
  team: Team | null;
  result: string | null; // win / draw / loss / pending
  survived: boolean | null;
}

// An LMS entry (one run through the competition). The primary entry is
// DB-backed (lms_picks); further entries are independent tracks. Entries are
// fully independent: their own used teams, status and recommendation.
export interface LmsEntry {
  id: string; // "entry-1"
  label: string; // "Entry 1"
  /** True once a draw/loss has knocked this entry out. */
  eliminated: boolean;
  /** Rounds already spent (used teams), oldest first. */
  picks: LmsEntryPick[];
  /** Only the primary entry persists to the DB; others are placeholders. */
  persisted: boolean;
}

// Forward plan (next five 7+-game rounds). The team allocation is placeholder
// logic — see LmsForwardPlan (// TODO wire the allocation engine).
export interface LmsForwardReserved {
  code: string; // teams.short_name held back
  isHome: boolean;
  reason: string;
}

export interface LmsForwardRound {
  round: number; // gw
  qualifies: boolean; // 7+ fixtures — counts for LMS
  numFixtures: number | null;
  provisionalPick: { code: string; isHome: boolean } | null;
  winProb: number | null;
  reason: string;
  reserved: LmsForwardReserved[];
}

export type LmsForwardPlan = LmsForwardRound[];

// ---- LMS rework: Competitions -> Entries (db/migrations/001_lms_rework.sql) ----

export type LmsEntryStatus = "alive" | "out";
export type LmsReserveStrategy = "safest" | "manual" | "smart";
export type LmsPickResult = "pending" | "survived" | "eliminated";

// Cross-entry variance ("Spread picks across entries"). See db/migrations/005 and
// computeCompetitionPlan in lib/lmsPlanner.ts.
//   off    — each entry independently takes its safest (PR A behaviour).
//   soft   — coordinate distinct teams that still clear each entry's confidence_floor.
//   strong — coordinate distinct teams with no floor.
export type LmsSpreadMode = "off" | "soft" | "strong";
// Per-pick provenance: 'spread' (differs from pure-safest due to coordination),
// 'matched' (duplicates a sibling / collapsed), or null (no spread effect).
export type LmsSpreadSource = "spread" | "matched" | null;

// Row shapes (mirror the migration/schema tables EXACTLY).
export interface LmsCompetition {
  id: number;
  user_id: number;
  name: string;
  start_gw: number;
  notes: string | null;
  created_at: string;
  spread_mode: LmsSpreadMode;
  spread_floor_soft: number; // numeric — MUST be Number()-coerced in the query layer
  // Rounds with fewer than this many PL fixtures are auto-skipped. null = no rule.
  auto_skip_under_fixtures: number | null;
}

// A per-round MANUAL skip (lms_competition_skipped_rounds).
export interface LmsCompetitionSkippedRound {
  competition_id: number;
  gw: number;
  reason: string | null;
  created_at: string;
}

// A per-round "use the same team across entries" override (lms_competition_spread_overrides).
export interface LmsCompetitionSpreadOverride {
  competition_id: number;
  gw: number;
  force_same: boolean;
}

export interface LmsCompetitionDeadline {
  competition_id: number;
  gw: number;
  deadline: string | null; // NULL = use computed default
}

export interface LmsEntryRow {
  id: number;
  competition_id: number;
  label: string;
  status: LmsEntryStatus;
  eliminated_gw: number | null;
  reserve_strategy: LmsReserveStrategy;
  confidence_floor: number; // numeric — MUST be Number()-coerced in the query layer
}

export interface LmsEntryPickRow {
  id: number;
  entry_id: number;
  gw: number;
  team_id: number;
  result: LmsPickResult;
  is_backfill: boolean;
  spread_source: LmsSpreadSource;
}

export interface LmsEntryReserve {
  entry_id: number;
  team_id: number;
}

// View models (composed reads for the UI).

// One entry's at-a-glance state, for the competitions list.
export interface LmsEntrySummary {
  id: number;
  label: string;
  status: LmsEntryStatus;
  eliminatedGw: number | null;
  strategy: LmsReserveStrategy;
  picksCount: number;
}

// A competition with per-entry summaries + the next upcoming deadline.
export interface LmsCompetitionSummary {
  id: number;
  name: string;
  startGw: number;
  notes: string | null;
  entries: LmsEntrySummary[];
  aliveCount: number;
  outCount: number;
  nextDeadline: { gw: number; deadline: string | null } | null;
}

// Full competition detail (competition + its entries as summaries).
export interface LmsCompetitionDetail {
  id: number;
  userId: number;
  name: string;
  startGw: number;
  notes: string | null;
  entries: LmsEntrySummary[];
  spreadMode: LmsSpreadMode;
  spreadFloorSoft: number;
  // Per-competition auto-skip threshold: rounds below this fixture count are
  // skipped. null = no fixture-count rule for this competition.
  autoSkipUnderFixtures: number | null;
  // Manually-skipped rounds for this competition (gw + optional reason).
  skippedRounds: { gw: number; reason: string | null }[];
}

// One submitted pick joined with its team for display.
export interface LmsEntryPickView {
  gw: number;
  team: Team | null;
  result: LmsPickResult;
  isBackfill: boolean;
  spreadSource: LmsSpreadSource;
}

// One entry's chosen (locked) / planned (spread engine) team for a single round,
// feeding PR D's cross-entry awareness row + duplicate detection.
export interface LmsSpreadEntryView {
  entryId: number;
  label: string;
  status: LmsEntryStatus;
  chosenTeam: Team | null; // locked pick for this round, if any
  plannedTeam: Team | null; // computeCompetitionPlan's team for this round
  plannedSpreadSource: LmsSpreadSource;
}

// The cross-entry picture for one round of a competition.
export interface LmsCompetitionSpreadView {
  competitionId: number;
  gw: number;
  spreadMode: LmsSpreadMode;
  forceSame: boolean; // an override row exists (force_same=true) for this round
  entries: LmsSpreadEntryView[];
  // Team ids backed by more than one alive entry this round (chosen or planned) —
  // the duplicates the awareness row flags.
  duplicateTeamIds: number[];
}

// One team with its single-use availability for this entry.
export interface LmsTeamOption {
  team: Team;
  used: boolean; // spent in a submitted round by this entry
  reserved: boolean; // in this entry's reserve list
  available: boolean; // not used and not reserved
}

// Full entry detail for the entry canvas.
export interface LmsEntryDetail {
  id: number;
  competitionId: number;
  label: string;
  status: LmsEntryStatus;
  eliminatedGw: number | null;
  strategy: LmsReserveStrategy;
  confidenceFloor: number;
  picks: LmsEntryPickView[];
  usedTeamIds: number[];
  reservedTeamIds: number[];
  teams: LmsTeamOption[];
}

// A gameweek fixture + model probs shaped for a home/draw/away ProbBar.
export interface LmsGameweekFixture {
  fixtureId: number;
  gw: number;
  homeTeam: Team | null;
  awayTeam: Team | null;
  kickoff: string | null;
  finished: boolean;
  // Shown distribution: = market when priced, = model otherwise (hard switch).
  pHome: number | null;
  pDraw: number | null;
  pAway: number | null;
  // The model's own view, kept alongside so the divergence badge can compare
  // model vs market even after p_* has switched to the market.
  modelPHome: number | null;
  modelPAway: number | null;
  // De-vigged bookmaker market + divergence. `marketAvailable` false => the
  // fixture is unpriced (usually a future round) and p_* is the model estimate.
  marketAvailable: boolean | null;
  marketPHome: number | null;
  marketPAway: number | null;
  marketDivergence: number | null;
}

// Round status derived from the deadline + fixtures' kickoffs/results.
//   open          — before the round deadline (picks allowed).
//   starting_soon — deadline passed, before the first kickoff.
//   in_progress   — first kickoff reached, results still pending.
//   complete      — all of the round's results are in.
//   unknown       — no fixtures/data to derive from.
export type LmsGwStatus =
  | "open"
  | "starting_soon"
  | "in_progress"
  | "complete"
  | "unknown";

// One standout player for the scouting detail block.
export interface PlayerStatLine {
  name: string; // players.web_name
  goals: number;
  xg: number | null; // expected goals for the season shown
}

// Which season the scouting numbers reflect. Current-season only: "current"
// once games are played, else "none" (pending) — no last-season fallback.
export type ScoutingSeason = "current" | "none";

// Per-team scouting glance shown on pick cards and expanded fixture rows:
// recent form (W/D/L), top scorers and team xG. Current-season data only; before
// this season's games are played the UI shows a pending state rather than
// last-season numbers (see player_season_stats / db/migrations/002_player_season_stats.sql).
export interface TeamScouting {
  teamId: number;
  season: ScoutingSeason;
  seasonLabel: string | null; // e.g. "2025/26" when season === "current"
  form: ("W" | "D" | "L")[]; // last ≤5 finished results, oldest → newest
  topScorers: PlayerStatLine[]; // up to 3, by goals desc
  goalsFor: number | null; // team goals in the season shown
  xgFor: number | null; // team expected goals in the season shown
}

// ---- History ----

// Canonical outcome shapes for recommendations_log.outcome jsonb.
// The pipeline back-fill MUST write exactly one of these two — NOT "correct" / "success" / "won".
// FPL recs (fpl_captain, fpl_transfer):  { hit: boolean; actual_points?: number }
// LMS recs (lms_pick):                   { survived: boolean; result: "win" | "draw" | "loss" }
export type CanonicalOutcome =
  | { hit: boolean; actual_points?: number }
  | { survived: boolean; result: "win" | "draw" | "loss" };

// RecommendationLog joined with player/team display names for the /history page.
export interface HistoryEntry extends RecommendationLog {
  player_name: string | null;     // players.web_name for fpl_captain / fpl_transfer
  team_name: string | null;       // teams.name for lms_pick
  team_short_name: string | null; // teams.short_name (3-letter code for ClubBadge)
}

// Accuracy stats computed server-side from HistoryEntry[].
export interface AccuracyStats {
  total: number;
  resolved: number;
  correct: number;
  hitRate: number | null;  // 0–1; null when resolved === 0
  trend: number | null;    // (recent-5 rate) − (overall rate); null when resolved < 5
  byKind: {
    fpl_captain: { correct: number; resolved: number };
    fpl_transfer: { correct: number; resolved: number };
    lms_pick: { correct: number; resolved: number };
  };
}
