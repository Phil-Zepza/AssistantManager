import { q } from "./db";
import type {
  Fixture,
  Gameweek,
  HistoryEntry,
  LmsCompetitionDetail,
  LmsCompetitionSummary,
  LmsEntryDetail,
  LmsEntryPickView,
  LmsEntryStatus,
  LmsCompetitionSpreadView,
  LmsFixtureOption,
  LmsGameweekFixture,
  LmsPick,
  LmsPickResult,
  LmsReserveStrategy,
  LmsSpreadMode,
  LmsSpreadSource,
  LmsTeamOption,
  ModelFixtureProbs,
  PickPoolEntry,
  Player,
  PlayerStatLine,
  Position,
  RecommendationLog,
  ScoutingSeason,
  SquadEntry,
  Team,
  TeamScouting,
  TransferSuggestion,
  User,
} from "./types";
import {
  computeCompetitionPlan,
  computeDefaultDeadline,
  computeEliteSet,
  type CompetitionEntryInput,
  type PlannerEntryState,
  type PlannerFixtureProb,
  type PlannerRound,
  type PlannerTeam,
  type SpreadOverride,
} from "./lmsPlanner";

const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];

// ---------- migration-lag tolerance ----------
//
// The web app can deploy (Vercel) ahead of the database getting its migrations
// applied (Railway pipeline) — see db/README.md. A read that references a column
// or table from a not-yet-applied migration then throws 42703 (undefined_column)
// or 42P01 (undefined_table), which — unguarded — 500s the whole route even
// though every OTHER query on the page is fine. That is exactly what blanked the
// LMS competition detail page: db/migrations/005_lms_spread_engine.sql adds
// lms_competitions.spread_mode / spread_floor_soft, lms_entry_picks.spread_source
// and the lms_competition_spread_overrides table, and the detail route reads all
// three. Rather than depend on the DB never lagging, we degrade those specific
// reads to their pre-005 shape (spread off, no overrides, null provenance) when —
// and only when — the schema is genuinely absent, mirroring the getTeamScouting
// guard for player_season_stats. A real query fault still surfaces.
function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42703" || code === "42P01";
}

// Run `primary`; if it fails ONLY because a migration has not been applied to this
// database yet, fall back to `fallback` (the pre-migration query). Any other error
// is a genuine fault and rethrows unchanged.
async function tolerateMissingSchema<T>(
  label: string,
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await primary();
  } catch (err) {
    if (isMissingSchemaError(err)) {
      console.warn(
        `[lms] ${label}: spread schema unavailable — degrading to pre-migration defaults:`,
        (err as { code?: string }).code,
      );
      return await fallback();
    }
    throw err;
  }
}

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

// Reference read: teams by id, for turning lms_picks.team_id into a short name
// on the profile. Teams are shared reference data — open to any signed-in user
// (no per-user scoping needed; the row set contains no user data).
export async function getTeamsByIds(ids: number[]): Promise<Team[]> {
  if (ids.length === 0) return [];
  return q<Team>(`select * from teams where fpl_id = any($1::int[])`, [ids]);
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

// ---------- LMS rework: Competitions -> Entries ----------

// teams row -> planner PlannerTeam shape.
function toPlannerTeam(t: Team): PlannerTeam {
  return {
    id: t.fpl_id,
    shortName: t.short_name,
    elo: t.elo,
    strengthAttack: t.strength_attack,
  };
}

// All competitions for a user, each with per-entry Alive/Out summaries and the
// next upcoming (eligible, unfinished) round's resolved deadline (override, else
// computed default). userId ALWAYS comes from the server session.
export async function getCompetitions(
  userId: number,
): Promise<LmsCompetitionSummary[]> {
  const rows = await q<{
    id: number;
    name: string;
    start_gw: number;
    notes: string | null;
    entry_id: number | null;
    label: string | null;
    status: LmsEntryStatus | null;
    eliminated_gw: number | null;
    reserve_strategy: LmsReserveStrategy | null;
    picks_count: string | null;
  }>(
    `select c.id, c.name, c.start_gw, c.notes,
            e.id as entry_id, e.label, e.status, e.eliminated_gw, e.reserve_strategy,
            (select count(*) from lms_entry_picks p where p.entry_id = e.id) as picks_count
       from lms_competitions c
       left join lms_entries e on e.competition_id = c.id
      where c.user_id = $1
      order by c.id asc, e.id asc`,
    [userId],
  );
  if (rows.length === 0) return [];

  // Next-deadline inputs: upcoming eligible unfinished rounds + their fixtures +
  // any per-competition overrides.
  const compIds = [...new Set(rows.map((r) => r.id))];
  const upcoming = await q<{ gw: number }>(
    `select gw from gameweeks
      where finished = false and lms_eligible = true
      order by gw asc`,
  );
  const upcomingGws = upcoming.map((u) => u.gw);
  const fixtures =
    upcomingGws.length > 0
      ? await q<{ gw: number; kickoff: string | null }>(
          `select gw, kickoff from fixtures where gw = any($1::int[])`,
          [upcomingGws],
        )
      : [];
  const overrides = await q<{
    competition_id: number;
    gw: number;
    deadline: string | null;
  }>(
    `select competition_id, gw, deadline from lms_competition_deadlines
      where competition_id = any($1::int[]) and deadline is not null`,
    [compIds],
  );
  const overrideByKey = new Map<string, string>();
  for (const o of overrides) {
    if (o.deadline != null) {
      overrideByKey.set(`${o.competition_id}:${o.gw}`, o.deadline);
    }
  }

  const resolveNextDeadline = (
    compId: number,
    startGw: number,
  ): { gw: number; deadline: string | null } | null => {
    const gw = upcomingGws.find((g) => g >= startGw);
    if (gw == null) return null;
    const deadline =
      overrideByKey.get(`${compId}:${gw}`) ?? computeDefaultDeadline(gw, fixtures);
    return { gw, deadline };
  };

  const byId = new Map<number, LmsCompetitionSummary>();
  for (const r of rows) {
    let comp = byId.get(r.id);
    if (!comp) {
      comp = {
        id: r.id,
        name: r.name,
        startGw: r.start_gw,
        notes: r.notes,
        entries: [],
        aliveCount: 0,
        outCount: 0,
        nextDeadline: resolveNextDeadline(r.id, r.start_gw),
      };
      byId.set(r.id, comp);
    }
    if (r.entry_id != null) {
      const status: LmsEntryStatus = r.status ?? "alive";
      comp.entries.push({
        id: r.entry_id,
        label: r.label ?? "",
        status,
        eliminatedGw: r.eliminated_gw,
        strategy: r.reserve_strategy ?? "smart",
        picksCount: Number(r.picks_count ?? 0),
      });
      if (status === "out") comp.outCount += 1;
      else comp.aliveCount += 1;
    }
  }
  return [...byId.values()];
}

// A single competition + its entries. Scoped by userId (returns null if the
// competition is not owned by this user).
export async function getCompetition(
  id: number,
  userId: number,
): Promise<LmsCompetitionDetail | null> {
  type CompRow = {
    id: number;
    user_id: number;
    name: string;
    start_gw: number;
    notes: string | null;
    spread_mode: LmsSpreadMode | null;
    spread_floor_soft: string | null; // numeric — coerce with Number()
  };
  const compRows = await tolerateMissingSchema(
    "getCompetition",
    () =>
      q<CompRow>(
        `select id, user_id, name, start_gw, notes, spread_mode, spread_floor_soft
           from lms_competitions where id = $1 and user_id = $2`,
        [id, userId],
      ),
    // spread_mode / spread_floor_soft not added yet -> pre-005 defaults below.
    () =>
      q<CompRow>(
        `select id, user_id, name, start_gw, notes,
                null as spread_mode, null as spread_floor_soft
           from lms_competitions where id = $1 and user_id = $2`,
        [id, userId],
      ),
  );
  const c = compRows[0];
  if (!c) return null;

  const entries = await q<{
    id: number;
    label: string;
    status: LmsEntryStatus;
    eliminated_gw: number | null;
    reserve_strategy: LmsReserveStrategy;
    picks_count: string;
  }>(
    `select e.id, e.label, e.status, e.eliminated_gw, e.reserve_strategy,
            (select count(*) from lms_entry_picks p where p.entry_id = e.id) as picks_count
       from lms_entries e where e.competition_id = $1 order by e.id asc`,
    [id],
  );

  return {
    id: c.id,
    userId: c.user_id,
    name: c.name,
    startGw: c.start_gw,
    notes: c.notes,
    entries: entries.map((e) => ({
      id: e.id,
      label: e.label,
      status: e.status,
      eliminatedGw: e.eliminated_gw,
      strategy: e.reserve_strategy,
      picksCount: Number(e.picks_count),
    })),
    spreadMode: c.spread_mode ?? "off",
    spreadFloorSoft: c.spread_floor_soft != null ? Number(c.spread_floor_soft) : 0.65,
  };
}

// Full entry detail: submitted picks, used teams, reserves, available teams,
// strategy and floor. Scoped through competition ownership (null if not owned).
export async function getEntry(
  id: number,
  userId: number,
): Promise<LmsEntryDetail | null> {
  const entryRows = await q<{
    id: number;
    competition_id: number;
    label: string;
    status: LmsEntryStatus;
    eliminated_gw: number | null;
    reserve_strategy: LmsReserveStrategy;
    confidence_floor: string; // numeric — coerce with Number()
  }>(
    `select e.id, e.competition_id, e.label, e.status, e.eliminated_gw,
            e.reserve_strategy, e.confidence_floor
       from lms_entries e
       join lms_competitions c on c.id = e.competition_id
      where e.id = $1 and c.user_id = $2`,
    [id, userId],
  );
  const e = entryRows[0];
  if (!e) return null;

  type PickRow = {
    gw: number;
    team_id: number;
    result: LmsPickResult;
    is_backfill: boolean;
    spread_source: LmsSpreadSource;
    team: Team | null;
  };
  const [pickRows, reserveRows, teams] = await Promise.all([
    tolerateMissingSchema(
      "getEntry.picks",
      () =>
        q<PickRow>(
          `select p.gw, p.team_id, p.result, p.is_backfill, p.spread_source,
                  to_jsonb(t.*) as team
             from lms_entry_picks p
             left join teams t on t.fpl_id = p.team_id
            where p.entry_id = $1 order by p.gw asc`,
          [id],
        ),
      // spread_source column not added yet -> null provenance.
      () =>
        q<PickRow>(
          `select p.gw, p.team_id, p.result, p.is_backfill,
                  null as spread_source, to_jsonb(t.*) as team
             from lms_entry_picks p
             left join teams t on t.fpl_id = p.team_id
            where p.entry_id = $1 order by p.gw asc`,
          [id],
        ),
    ),
    q<{ team_id: number }>(
      `select team_id from lms_entry_reserves where entry_id = $1`,
      [id],
    ),
    getAllTeams(),
  ]);

  const usedTeamIds = pickRows.map((p) => p.team_id);
  const reservedTeamIds = reserveRows.map((r) => r.team_id);
  const usedSet = new Set(usedTeamIds);
  const reservedSet = new Set(reservedTeamIds);

  const picks: LmsEntryPickView[] = pickRows.map((p) => ({
    gw: p.gw,
    team: p.team,
    result: p.result,
    isBackfill: p.is_backfill,
    spreadSource: p.spread_source,
  }));

  const teamOptions: LmsTeamOption[] = teams.map((t) => {
    const used = usedSet.has(t.fpl_id);
    const reserved = reservedSet.has(t.fpl_id);
    return { team: t, used, reserved, available: !used && !reserved };
  });

  return {
    id: e.id,
    competitionId: e.competition_id,
    label: e.label,
    status: e.status,
    eliminatedGw: e.eliminated_gw,
    strategy: e.reserve_strategy,
    confidenceFloor: Number(e.confidence_floor),
    picks,
    usedTeamIds,
    reservedTeamIds,
    teams: teamOptions,
  };
}

// Fixtures for a gameweek + model probs, shaped for a home/draw/away ProbBar.
export async function getGameweekFixtures(
  gw: number,
): Promise<LmsGameweekFixture[]> {
  const rows = await q<{
    fixture: Fixture;
    homeTeam: Team | null;
    awayTeam: Team | null;
    probs: ModelFixtureProbs | null;
  }>(
    `select to_jsonb(f.*)  as fixture,
            to_jsonb(th.*) as "homeTeam",
            to_jsonb(ta.*) as "awayTeam",
            to_jsonb(mp.*) as probs
       from fixtures f
       left join teams th on th.fpl_id = f.home_team
       left join teams ta on ta.fpl_id = f.away_team
       left join model_fixture_probs mp on mp.fixture_id = f.fpl_id
      where f.gw = $1
      order by f.kickoff asc nulls last, f.fpl_id asc`,
    [gw],
  );
  return rows.map((r) => ({
    fixtureId: r.fixture.fpl_id,
    gw: r.fixture.gw ?? gw,
    homeTeam: r.homeTeam,
    awayTeam: r.awayTeam,
    kickoff: r.fixture.kickoff,
    finished: r.fixture.finished,
    pHome: r.probs?.p_home ?? null,
    pDraw: r.probs?.p_draw ?? null,
    pAway: r.probs?.p_away ?? null,
    marketPHome: r.probs?.market_p_home ?? null,
    marketPAway: r.probs?.market_p_away ?? null,
    marketDivergence: r.probs?.market_divergence ?? null,
  }));
}

// The competition-global slice of the planner inputs: teams, upcoming rounds and
// fixture win-probabilities from `startGw`, plus the elo-derived elite set. Shared
// by getForwardPlanInputs and getCompetitionSpreadView (identical for every entry
// in a competition — same fixtures). `startGw` is the competition's start_gw.
interface CompetitionGlobals {
  teams: PlannerTeam[];
  upcomingRounds: PlannerRound[];
  fixtureProbs: PlannerFixtureProb[];
  eliteSet: number[];
}

async function getCompetitionGlobals(startGw: number): Promise<CompetitionGlobals> {
  const [teamsRows, roundRows, probRows] = await Promise.all([
    getAllTeams(),
    q<{ gw: number; lms_eligible: boolean; num_fixtures: number | null }>(
      `select gw, lms_eligible, num_fixtures from gameweeks
        where finished = false and gw >= $1 order by gw asc`,
      [startGw],
    ),
    q<{
      fixture_id: number;
      gw: number | null;
      home_team: number | null;
      away_team: number | null;
      p_home: number | null;
      p_draw: number | null;
      p_away: number | null;
    }>(
      `select f.fpl_id as fixture_id, f.gw, f.home_team, f.away_team,
              mp.p_home, mp.p_draw, mp.p_away
         from fixtures f
         join model_fixture_probs mp on mp.fixture_id = f.fpl_id
        where f.finished = false and f.gw >= $1`,
      [startGw],
    ),
  ]);

  const teams: PlannerTeam[] = teamsRows.map(toPlannerTeam);
  const fixtureProbs: PlannerFixtureProb[] = probRows
    .filter((r) => r.gw != null && r.home_team != null && r.away_team != null)
    .map((r) => ({
      fixtureId: r.fixture_id,
      gw: r.gw as number,
      homeTeamId: r.home_team as number,
      awayTeamId: r.away_team as number,
      pHome: r.p_home,
      pDraw: r.p_draw,
      pAway: r.p_away,
    }));

  return {
    teams,
    upcomingRounds: roundRows.map((r) => ({
      gw: r.gw,
      lmsEligible: r.lms_eligible,
      numFixtures: r.num_fixtures,
    })),
    fixtureProbs,
    eliteSet: computeEliteSet(teams),
  };
}

// One alive entry's planner state + display label, for the joint spread pass.
export interface AliveEntryInput extends CompetitionEntryInput {
  label: string;
  status: LmsEntryStatus;
}

// Every ALIVE entry's used-teams + reserves + strategy + floor for a competition,
// in deterministic (ascending id) order. The spread pass needs all siblings at once.
async function getAliveEntryInputs(
  competitionId: number,
): Promise<AliveEntryInput[]> {
  const entryRows = await q<{
    id: number;
    label: string;
    status: LmsEntryStatus;
    reserve_strategy: LmsReserveStrategy;
    confidence_floor: string;
  }>(
    `select id, label, status, reserve_strategy, confidence_floor
       from lms_entries
      where competition_id = $1 and status = 'alive'
      order by id asc`,
    [competitionId],
  );
  if (entryRows.length === 0) return [];

  const ids = entryRows.map((e) => e.id);
  const [usedRows, reserveRows] = await Promise.all([
    q<{ entry_id: number; team_id: number }>(
      `select entry_id, team_id from lms_entry_picks where entry_id = any($1::int[])`,
      [ids],
    ),
    q<{ entry_id: number; team_id: number }>(
      `select entry_id, team_id from lms_entry_reserves where entry_id = any($1::int[])`,
      [ids],
    ),
  ]);
  const groupByEntry = (rows: { entry_id: number; team_id: number }[]) => {
    const m = new Map<number, number[]>();
    for (const r of rows) {
      const list = m.get(r.entry_id);
      if (list) list.push(r.team_id);
      else m.set(r.entry_id, [r.team_id]);
    }
    return m;
  };
  const usedByEntry = groupByEntry(usedRows);
  const reservedByEntry = groupByEntry(reserveRows);

  return entryRows.map((e) => ({
    entryId: e.id,
    label: e.label,
    status: e.status,
    entryState: {
      usedTeamIds: usedByEntry.get(e.id) ?? [],
      reservedTeamIds: reservedByEntry.get(e.id) ?? [],
      strategy: e.reserve_strategy,
      confidenceFloor: Number(e.confidence_floor),
    },
  }));
}

// Per-round force_same overrides for a competition (only rows with force_same=true).
async function getSpreadOverrides(
  competitionId: number,
): Promise<SpreadOverride[]> {
  return tolerateMissingSchema(
    "getSpreadOverrides",
    async () => {
      const rows = await q<{ gw: number; force_same: boolean }>(
        `select gw, force_same from lms_competition_spread_overrides
          where competition_id = $1`,
        [competitionId],
      );
      return rows.map((r) => ({ gw: r.gw, forceSame: r.force_same }));
    },
    // lms_competition_spread_overrides table not created yet -> no overrides.
    async () => [],
  );
}

// The bundle of inputs the pure planner (lib/lmsPlanner.ts) needs. Assembled
// server-side; the client calls computeForwardPlan() with this (+ any pins) and
// recomputes live on every override — nothing here is persisted.
//
// The `entryState` + base fields drive the per-entry computeForwardPlan; the
// spread fields (spreadMode/spreadFloorSoft/spreadOverrides + aliveEntries — every
// alive sibling's planner state) drive computeCompetitionPlan.
export interface ForwardPlanInputs {
  entryState: PlannerEntryState;
  upcomingRounds: PlannerRound[];
  fixtureProbs: PlannerFixtureProb[];
  teams: PlannerTeam[];
  eliteSet: number[];
  competitionId: number;
  spreadMode: LmsSpreadMode;
  spreadFloorSoft: number;
  spreadOverrides: SpreadOverride[];
  aliveEntries: AliveEntryInput[];
}

export async function getForwardPlanInputs(
  entryId: number,
  userId: number,
): Promise<ForwardPlanInputs | null> {
  type EntryRow = {
    id: number;
    competition_id: number;
    start_gw: number;
    reserve_strategy: LmsReserveStrategy;
    confidence_floor: string;
    spread_mode: LmsSpreadMode | null;
    spread_floor_soft: string | null;
  };
  const entryRows = await tolerateMissingSchema(
    "getForwardPlanInputs",
    () =>
      q<EntryRow>(
        `select e.id, e.competition_id, c.start_gw, e.reserve_strategy, e.confidence_floor,
                c.spread_mode, c.spread_floor_soft
           from lms_entries e
           join lms_competitions c on c.id = e.competition_id
          where e.id = $1 and c.user_id = $2`,
        [entryId, userId],
      ),
    // spread_mode / spread_floor_soft not added yet -> pre-005 defaults below.
    () =>
      q<EntryRow>(
        `select e.id, e.competition_id, c.start_gw, e.reserve_strategy, e.confidence_floor,
                null as spread_mode, null as spread_floor_soft
           from lms_entries e
           join lms_competitions c on c.id = e.competition_id
          where e.id = $1 and c.user_id = $2`,
        [entryId, userId],
      ),
  );
  const e = entryRows[0];
  if (!e) return null;

  const [usedRows, reserveRows, globals, aliveEntries, spreadOverrides] =
    await Promise.all([
      q<{ team_id: number }>(
        `select team_id from lms_entry_picks where entry_id = $1`,
        [entryId],
      ),
      q<{ team_id: number }>(
        `select team_id from lms_entry_reserves where entry_id = $1`,
        [entryId],
      ),
      getCompetitionGlobals(e.start_gw),
      getAliveEntryInputs(e.competition_id),
      getSpreadOverrides(e.competition_id),
    ]);

  return {
    entryState: {
      usedTeamIds: usedRows.map((u) => u.team_id),
      reservedTeamIds: reserveRows.map((r) => r.team_id),
      strategy: e.reserve_strategy,
      confidenceFloor: Number(e.confidence_floor),
    },
    upcomingRounds: globals.upcomingRounds,
    fixtureProbs: globals.fixtureProbs,
    teams: globals.teams,
    eliteSet: globals.eliteSet,
    competitionId: e.competition_id,
    spreadMode: e.spread_mode ?? "off",
    spreadFloorSoft: e.spread_floor_soft != null ? Number(e.spread_floor_soft) : 0.65,
    spreadOverrides,
    aliveEntries,
  };
}

// The cross-entry picture for ONE round of a competition: each alive entry's
// locked (chosen) team and the spread engine's planned team for that round, plus
// the teams backed by more than one alive entry (the duplicates PR D's awareness
// row flags). Scoped by userId (ownership), matching getCompetition/getEntry.
export async function getCompetitionSpreadView(
  competitionId: number,
  userId: number,
  gw: number,
): Promise<LmsCompetitionSpreadView | null> {
  type SpreadCompRow = {
    id: number;
    start_gw: number;
    spread_mode: LmsSpreadMode | null;
    spread_floor_soft: string | null;
  };
  const compRows = await tolerateMissingSchema(
    "getCompetitionSpreadView",
    () =>
      q<SpreadCompRow>(
        `select id, start_gw, spread_mode, spread_floor_soft
           from lms_competitions where id = $1 and user_id = $2`,
        [competitionId, userId],
      ),
    // spread_mode / spread_floor_soft not added yet -> spread off, default floor.
    () =>
      q<SpreadCompRow>(
        `select id, start_gw, null as spread_mode, null as spread_floor_soft
           from lms_competitions where id = $1 and user_id = $2`,
        [competitionId, userId],
      ),
  );
  const c = compRows[0];
  if (!c) return null;
  const spreadMode: LmsSpreadMode = c.spread_mode ?? "off";
  const spreadFloorSoft =
    c.spread_floor_soft != null ? Number(c.spread_floor_soft) : 0.65;

  const [globals, aliveEntries, spreadOverrides] = await Promise.all([
    getCompetitionGlobals(c.start_gw),
    getAliveEntryInputs(competitionId),
    getSpreadOverrides(competitionId),
  ]);

  const teamByFplId = new Map<number, Team>();
  for (const t of await getAllTeams()) teamByFplId.set(t.fpl_id, t);

  // Locked (chosen) picks for this round, per entry.
  const aliveIds = aliveEntries.map((e) => e.entryId);
  const chosenRows =
    aliveIds.length > 0
      ? await q<{ entry_id: number; team_id: number }>(
          `select entry_id, team_id from lms_entry_picks
            where entry_id = any($1::int[]) and gw = $2`,
          [aliveIds, gw],
        )
      : [];
  const chosenByEntry = new Map<number, number>();
  for (const r of chosenRows) chosenByEntry.set(r.entry_id, r.team_id);

  // Planned team per entry for this round, from the pure joint engine.
  const plan = computeCompetitionPlan({
    entries: aliveEntries.map((e) => ({
      entryId: e.entryId,
      entryState: e.entryState,
    })),
    upcomingRounds: globals.upcomingRounds,
    fixtureProbs: globals.fixtureProbs,
    teams: globals.teams,
    eliteSet: globals.eliteSet,
    spreadMode,
    spreadFloorSoft,
    overrides: spreadOverrides,
  });
  const plannedByEntry = new Map<
    number,
    { teamId: number | null; spreadSource: LmsSpreadSource }
  >();
  for (const ep of plan.entries) {
    const pick = ep.picks.find((p) => p.gw === gw);
    plannedByEntry.set(ep.entryId, {
      teamId: pick?.teamId ?? null,
      spreadSource: pick?.spreadSource ?? null,
    });
  }

  const entries = aliveEntries.map((e) => {
    const chosenId = chosenByEntry.get(e.entryId) ?? null;
    const planned = plannedByEntry.get(e.entryId);
    return {
      entryId: e.entryId,
      label: e.label,
      status: e.status,
      chosenTeam: chosenId != null ? (teamByFplId.get(chosenId) ?? null) : null,
      plannedTeam:
        planned?.teamId != null ? (teamByFplId.get(planned.teamId) ?? null) : null,
      plannedSpreadSource: planned?.spreadSource ?? null,
    };
  });

  // Duplicates: a team backed (chosen if locked, else planned) by >1 alive entry.
  const counts = new Map<number, number>();
  for (const e of entries) {
    const id = e.chosenTeam?.fpl_id ?? e.plannedTeam?.fpl_id ?? null;
    if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const duplicateTeamIds = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id);

  return {
    competitionId,
    gw,
    spreadMode,
    forceSame: spreadOverrides.some((o) => o.gw === gw && o.forceSame),
    entries,
    duplicateTeamIds,
  };
}

// Per-team scouting glance (recent form + top scorers + team xG) for the LMS
// detail block. Prefers current-season stats, falling back to the most recent
// past season (season === "last") until games are played. Reference/model data
// — open to any signed-in user (no per-user rows). Empty input -> empty result.
export async function getTeamScouting(
  teamIds: number[],
): Promise<TeamScouting[]> {
  const ids = [...new Set(teamIds.filter((id) => Number.isInteger(id)))];
  if (ids.length === 0) return [];

  type StatRow = {
    team_id: number;
    web_name: string;
    season: string;
    is_current: boolean;
    minutes: number | null;
    goals: number | null;
    xg: number | null;
  };

  const [statRows, resultRows] = await Promise.all([
    // player_season_stats is a planned table (see
    // db/migrations/002_player_season_stats.sql) that is not yet provisioned on
    // every environment, and preseason it has no rows anyway. If it's absent we
    // degrade the scouting block to form-only rather than 500 the whole detail
    // page — recent form below comes from `fixtures`, which always exists.
    q<StatRow>(
      `select p.team_id, p.web_name, s.season, s.is_current,
              s.minutes, s.goals, s.xg
         from players p
         join player_season_stats s on s.player_id = p.fpl_id
        where p.team_id = any($1::int[])`,
      [ids],
    ).catch((err: unknown): StatRow[] => {
      const code = (err as { code?: string } | null)?.code;
      // 42P01 undefined_table, 42703 undefined_column — the season-stats
      // source isn't there. Any other error is a real fault; rethrow it.
      if (code === "42P01" || code === "42703") {
        console.warn(
          "[scouting] player_season_stats unavailable — degrading to form-only:",
          code,
        );
        return [];
      }
      throw err;
    }),
    q<{
      home_team: number | null;
      away_team: number | null;
      home_score: number | null;
      away_score: number | null;
    }>(
      `select home_team, away_team, home_score, away_score
         from fixtures
        where finished = true
          and home_score is not null and away_score is not null
          and (home_team = any($1::int[]) or away_team = any($1::int[]))
        order by kickoff asc nulls last, fpl_id asc`,
      [ids],
    ),
  ]);

  // Recent form: last ≤5 finished results per team, oldest → newest.
  const formByTeam = new Map<number, ("W" | "D" | "L")[]>();
  for (const id of ids) formByTeam.set(id, []);
  for (const r of resultRows) {
    if (r.home_score == null || r.away_score == null) continue;
    const push = (id: number, res: "W" | "D" | "L") => {
      const arr = formByTeam.get(id);
      if (arr) arr.push(res);
    };
    const homeRes: "W" | "D" | "L" =
      r.home_score > r.away_score ? "W" : r.home_score < r.away_score ? "L" : "D";
    const awayRes: "W" | "D" | "L" =
      homeRes === "W" ? "L" : homeRes === "L" ? "W" : "D";
    if (r.home_team != null && formByTeam.has(r.home_team)) push(r.home_team, homeRes);
    if (r.away_team != null && formByTeam.has(r.away_team)) push(r.away_team, awayRes);
  }

  // Group season stat rows by team, split current vs. most-recent past season.
  interface TeamRows {
    current: typeof statRows;
    pastBySeason: Map<string, typeof statRows>;
  }
  const byTeam = new Map<number, TeamRows>();
  for (const r of statRows) {
    let t = byTeam.get(r.team_id);
    if (!t) {
      t = { current: [], pastBySeason: new Map() };
      byTeam.set(r.team_id, t);
    }
    if (r.is_current) {
      t.current.push(r);
    } else {
      const list = t.pastBySeason.get(r.season) ?? [];
      list.push(r);
      t.pastBySeason.set(r.season, list);
    }
  }

  const sum = (rows: typeof statRows, key: "goals" | "xg"): number =>
    rows.reduce((acc, r) => acc + (r[key] ?? 0), 0);

  const topScorers = (rows: typeof statRows): PlayerStatLine[] =>
    [...rows]
      .filter((r) => (r.goals ?? 0) > 0)
      .sort((a, b) => (b.goals ?? 0) - (a.goals ?? 0) || (b.xg ?? 0) - (a.xg ?? 0))
      .slice(0, 3)
      .map((r) => ({ name: r.web_name, goals: r.goals ?? 0, xg: r.xg }));

  return ids.map((teamId): TeamScouting => {
    const t = byTeam.get(teamId);
    const form = formByTeam.get(teamId) ?? [];
    const form5 = form.slice(-5);

    if (!t) {
      return {
        teamId,
        season: "none",
        seasonLabel: null,
        form: form5,
        topScorers: [],
        goalsFor: null,
        xgFor: null,
      };
    }

    // Prefer current-season data once any minutes have been played this season.
    const currentMinutes = t.current.reduce((a, r) => a + (r.minutes ?? 0), 0);

    let season: ScoutingSeason;
    let seasonLabel: string | null;
    let rows: typeof statRows;

    if (currentMinutes > 0) {
      season = "current";
      seasonLabel = t.current[0]?.season ?? null;
      rows = t.current;
    } else if (t.pastBySeason.size > 0) {
      // most recent past season by label (season strings sort chronologically)
      const latest = [...t.pastBySeason.keys()].sort().at(-1)!;
      season = "last";
      seasonLabel = latest;
      rows = t.pastBySeason.get(latest)!;
    } else {
      season = "none";
      seasonLabel = null;
      rows = [];
    }

    return {
      teamId,
      season,
      seasonLabel,
      form: form5,
      topScorers: topScorers(rows),
      goalsFor: rows.length > 0 ? sum(rows, "goals") : null,
      xgFor: rows.length > 0 ? Math.round(sum(rows, "xg") * 10) / 10 : null,
    };
  });
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

// Extended history query — joins players/teams so the UI can render
// "Captain Salah" / "Pick Arsenal (72%)" without raw IDs.
export async function getHistoryEntries(
  userId: number,
): Promise<HistoryEntry[]> {
  return q<HistoryEntry>(
    `select r.*,
       p.web_name      as player_name,
       t.name          as team_name,
       t.short_name    as team_short_name
     from recommendations_log r
     left join players p on p.fpl_id = (r.payload->>'player_id')::int
     left join teams   t on t.fpl_id = (r.payload->>'team_id')::int
     where r.user_id = $1
     order by r.gw desc, r.created_at desc
     limit 200`,
    [userId],
  );
}
