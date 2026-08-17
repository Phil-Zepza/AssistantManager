import { q } from "./db";
import type {
  Fixture,
  Gameweek,
  LmsFixtureOption,
  LmsPick,
  ModelFixtureProbs,
  PickPoolEntry,
  Player,
  Position,
  RecommendationLog,
  SquadEntry,
  Team,
  TransferSuggestion,
  User,
} from "./types";

const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];

// ---------- current user profile ----------

// Load the app profile row for the signed-in user. `userId` ALWAYS comes from
// the server-side session (auth()), never from client input.
export async function getCurrentUser(userId: number): Promise<User | null> {
  const rows = await q<User>(
    `select id, name, email, display_name, fpl_entry_id, created_at
       from users where id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

// ---------- dashboard: squad ----------

// Returns the squad for the requested GW; if none, falls back to the latest GW
// this user has any squad rows for. Empty array when the user has no squad.
export async function getSquad(
  userId: number,
  gw: number | null,
): Promise<{ gw: number | null; entries: SquadEntry[] }> {
  let targetGw = gw;

  if (targetGw != null) {
    const rows = await q<{ n: string }>(
      `select count(*)::text as n from user_squad where user_id = $1 and gw = $2`,
      [userId, targetGw],
    );
    if (!rows[0] || Number(rows[0].n) === 0) targetGw = null;
  }

  if (targetGw == null) {
    const latest = await q<{ gw: number }>(
      `select gw from user_squad where user_id = $1 order by gw desc limit 1`,
      [userId],
    );
    if (latest.length === 0) return { gw: null, entries: [] };
    targetGw = latest[0].gw;
  }

  // Single scoped join: squad ⋈ players ⋈ teams ⋈ model_player_ep for this GW.
  const rows = await q<{
    is_captain: boolean;
    is_vice: boolean;
    on_bench: boolean;
    expected_points: number | null;
    player: Player;
    team: Team | null;
  }>(
    `select
        us.is_captain,
        us.is_vice,
        us.on_bench,
        ep.expected_points as expected_points,
        to_jsonb(p.*)  as player,
        to_jsonb(t.*)  as team
       from user_squad us
       join players p on p.fpl_id = us.player_id
       left join teams t on t.fpl_id = p.team_id
       left join model_player_ep ep
         on ep.player_id = us.player_id and ep.gw = us.gw and ep.horizon = 1
      where us.user_id = $1 and us.gw = $2`,
    [userId, targetGw],
  );

  const entries: SquadEntry[] = rows.map((r) => ({
    player: r.player,
    team: r.team,
    expected_points: r.expected_points,
    is_captain: !!r.is_captain,
    is_vice: !!r.is_vice,
    on_bench: !!r.on_bench,
  }));

  return { gw: targetGw, entries };
}

// Highest-EP non-bench player = recommended captain.
export function recommendedCaptain(entries: SquadEntry[]): SquadEntry | null {
  const starters = entries.filter(
    (e) => !e.on_bench && e.expected_points != null,
  );
  if (starters.length === 0) return null;
  return starters.reduce((best, e) =>
    (e.expected_points ?? -Infinity) > (best.expected_points ?? -Infinity)
      ? e
      : best,
  );
}

// ---------- squad picker: selectable player pool ----------

// All players joined to their club, their current-GW projection, and their
// team's next fixture (opponent + difficulty). Reference/model data — open to
// any signed-in user (no per-user scoping needed; contains no user rows).
//
// `gw` is the current gameweek: projections come from model_player_ep for that
// GW (horizon 1), and the "next fixture" is the earliest unfinished fixture for
// each player's team from `gw` onward.
export async function getPlayerPool(
  gw: number | null,
): Promise<PickPoolEntry[]> {
  if (gw == null) return [];

  const rows = await q<{
    expected_points: number | null;
    player: Player;
    team: Team | null;
    fixture_id: number | null;
    fixture_gw: number | null;
    is_home: boolean | null;
    difficulty: number | null;
    win_prob: number | null;
    opponent: Team | null;
  }>(
    `select
        p_ep.expected_points as expected_points,
        to_jsonb(p.*)   as player,
        to_jsonb(t.*)   as team,
        nf.fpl_id       as fixture_id,
        nf.gw           as fixture_gw,
        nf.is_home      as is_home,
        nf.difficulty   as difficulty,
        nf.win_prob     as win_prob,
        to_jsonb(opp.*) as opponent
       from players p
       left join teams t on t.fpl_id = p.team_id
       left join model_player_ep p_ep
         on p_ep.player_id = p.fpl_id and p_ep.gw = $1 and p_ep.horizon = 1
       left join lateral (
         select
            f.fpl_id,
            f.gw,
            (f.home_team = p.team_id)                                   as is_home,
            case when f.home_team = p.team_id
                 then f.home_team else f.away_team end                  as opp_team,
            case when f.home_team = p.team_id
                 then f.home_diff else f.away_diff end                  as difficulty,
            case when f.home_team = p.team_id
                 then mfp.p_home else mfp.p_away end                    as win_prob
           from fixtures f
           left join model_fixture_probs mfp on mfp.fixture_id = f.fpl_id
          where (f.home_team = p.team_id or f.away_team = p.team_id)
            and f.finished = false
            and f.gw is not null
            and f.gw >= $1
          order by f.gw asc, f.kickoff asc nulls last
          limit 1
       ) nf on true
       left join teams opp on opp.fpl_id = nf.opp_team
      order by p_ep.expected_points desc nulls last, p.web_name asc`,
    [gw],
  );

  return rows.map((r) => ({
    player: r.player,
    team: r.team,
    expected_points: r.expected_points,
    next_fixture:
      r.fixture_id != null
        ? {
            fixture_id: r.fixture_id,
            gw: r.fixture_gw,
            is_home: !!r.is_home,
            opponent: r.opponent,
            difficulty: r.difficulty,
            win_prob: r.win_prob,
          }
        : null,
  }));
}

// Load an existing squad for (user, gw) as plain selection rows, for seeding the
// editor. `userId` ALWAYS comes from the server session. Empty when none exist.
export async function getSquadSelections(
  userId: number,
  gw: number | null,
): Promise<
  { player_id: number; is_captain: boolean; is_vice: boolean; on_bench: boolean }[]
> {
  if (gw == null) return [];
  return q(
    `select player_id, is_captain, is_vice, on_bench
       from user_squad where user_id = $1 and gw = $2`,
    [userId, gw],
  );
}

// ---------- dashboard: best transfer (simplest version) ----------

// Top EP player per position that the user does NOT already own. Reference/model
// data — open to any signed-in user; `ownedPlayerIds` are the user's own picks.
export async function getBestTransfers(
  gw: number | null,
  ownedPlayerIds: number[],
): Promise<TransferSuggestion[]> {
  if (gw == null) return [];

  // Highest-EP player per position, excluding owned players, ranked in SQL.
  const rows = await q<{
    expected_points: number | null;
    player: Player;
    team: Team | null;
  }>(
    `select distinct on (p.position)
        ep.expected_points as expected_points,
        to_jsonb(p.*) as player,
        to_jsonb(t.*) as team
       from model_player_ep ep
       join players p on p.fpl_id = ep.player_id
       left join teams t on t.fpl_id = p.team_id
      where ep.gw = $1
        and ep.horizon = 1
        and not (p.fpl_id = any($2::int[]))
      order by p.position, ep.expected_points desc nulls last`,
    [gw, ownedPlayerIds],
  );

  const byPos = new Map<Position, TransferSuggestion>();
  for (const r of rows) {
    byPos.set(r.player.position, {
      position: r.player.position,
      player: r.player,
      team: r.team,
      expected_points: r.expected_points,
    });
  }

  return POSITIONS.map((p) => byPos.get(p)).filter(
    (s): s is TransferSuggestion => s !== undefined,
  );
}

// ---------- LMS ----------

export async function getLmsPicks(userId: number): Promise<LmsPick[]> {
  return q<LmsPick>(
    `select * from lms_picks where user_id = $1 order by round_gw asc`,
    [userId],
  );
}

// Build ranked fixture options for a GW, marking already-used teams.
export async function getLmsFixtureOptions(
  gw: number,
  usedTeamIds: number[],
): Promise<LmsFixtureOption[]> {
  const rows = await q<{
    fixture: Fixture;
    homeTeam: Team | null;
    awayTeam: Team | null;
    probs: ModelFixtureProbs | null;
  }>(
    `select
        to_jsonb(f.*)  as fixture,
        to_jsonb(th.*) as "homeTeam",
        to_jsonb(ta.*) as "awayTeam",
        to_jsonb(mp.*) as probs
       from fixtures f
       left join teams th on th.fpl_id = f.home_team
       left join teams ta on ta.fpl_id = f.away_team
       left join model_fixture_probs mp on mp.fixture_id = f.fpl_id
      where f.gw = $1`,
    [gw],
  );

  if (rows.length === 0) return [];

  const used = new Set(usedTeamIds);

  const options: LmsFixtureOption[] = rows.map((r) => {
    const f = r.fixture;
    const homeTeam = r.homeTeam;
    const awayTeam = r.awayTeam;
    const p = r.probs;

    const pHome = p?.p_home ?? null;
    const pAway = p?.p_away ?? null;

    let pickIsHome = true;
    let pickWinProb: number | null = null;
    let pickTeam: Team | null = null;

    if (pHome != null || pAway != null) {
      pickIsHome = (pHome ?? -1) >= (pAway ?? -1);
      pickWinProb = pickIsHome ? pHome : pAway;
      pickTeam = pickIsHome ? homeTeam : awayTeam;
    }

    const alreadyUsed =
      (!!f.home_team && used.has(f.home_team) && pickIsHome) ||
      (!!f.away_team && used.has(f.away_team) && !pickIsHome);

    return {
      fixture: f,
      homeTeam,
      awayTeam,
      probs: p,
      pickTeam,
      pickWinProb,
      pickIsHome,
      alreadyUsed,
    };
  });

  // Rank by the backed team's win probability (desc); nulls last.
  options.sort((a, b) => (b.pickWinProb ?? -1) - (a.pickWinProb ?? -1));
  return options;
}

// All teams (reference data), ordered by name. Used by the LMS canvas to render
// the "used this season" and "available" team pools. Open to any signed-in user
// (contains no per-user rows).
export async function getAllTeams(): Promise<Team[]> {
  return q<Team>(`select * from teams order by name asc`);
}

// Upcoming gameweeks from `fromGw` (inclusive), for the LMS forward plan. Kept
// deliberately un-filtered on eligibility: the plan renders honest "skipped ·
// under 7" markers for sub-7-fixture rounds, so it needs those rows too.
// Reference data — open to any signed-in user.
export async function getUpcomingGameweeks(
  fromGw: number | null,
  limit = 14,
): Promise<Gameweek[]> {
  if (fromGw == null) return [];
  return q<Gameweek>(
    `select * from gameweeks where gw >= $1 order by gw asc limit $2`,
    [fromGw, limit],
  );
}

// Recommended LMS pick = highest win prob among fixtures whose backed team
// has not been used yet.
export function recommendedLmsPick(
  options: LmsFixtureOption[],
  usedTeamIds: number[],
): LmsFixtureOption | null {
  const used = new Set(usedTeamIds);
  const eligible = options.filter((o) => {
    if (o.pickWinProb == null || !o.pickTeam) return false;
    return !used.has(o.pickTeam.fpl_id);
  });
  if (eligible.length === 0) return null;
  return eligible.reduce((best, o) =>
    (o.pickWinProb ?? -1) > (best.pickWinProb ?? -1) ? o : best,
  );
}

// ---------- history ----------

export async function getRecommendations(
  userId: number,
): Promise<RecommendationLog[]> {
  return q<RecommendationLog>(
    `select * from recommendations_log
       where user_id = $1
       order by created_at desc
       limit 200`,
    [userId],
  );
}
