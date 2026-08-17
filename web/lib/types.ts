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
  p_home: number | null;
  p_draw: number | null;
  p_away: number | null;
  exp_goals_h: number | null;
  exp_goals_a: number | null;
  computed_at: string;
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

// One LMS entry (round pick) with a derived survival status for the profile.
export type LmsStatus = "alive" | "out" | "pending";

export interface LmsEntry {
  round_gw: number;
  teamShort: string | null; // backed team short name (null if unknown)
  result: string | null; // win / draw / loss / pending (raw)
  status: LmsStatus; // derived: strict "draw = out"
}

export interface LmsSummary {
  entries: number; // number of round picks on record
  alive: boolean; // still in it (no round lost/drawn yet)
  rounds: LmsEntry[];
}
