// Pure LMS view-model helpers for the /lms canvas. No DB access here — these
// transform already-fetched rows (lib/queries.ts) into the shapes the canvas
// renders. Safe to import from either server or client components.

import type {
  Gameweek,
  LmsEntry,
  LmsEntryPick,
  LmsFixtureOption,
  LmsForwardPlan,
  LmsPick,
  Team,
} from "./types";

// Top-N backing options for a round with the given used teams excluded, highest
// win prob first. `options` are assumed already win-prob ranked (as returned by
// getLmsFixtureOptions). Guarantees a used team can never surface as a pick.
// Pure (no DB) so it is safe to call from client components.
export function rankedLmsPicks(
  options: LmsFixtureOption[],
  usedTeamIds: number[],
  n = 3,
): LmsFixtureOption[] {
  const used = new Set(usedTeamIds);
  return options
    .filter(
      (o) =>
        o.pickTeam != null &&
        o.pickWinProb != null &&
        !used.has(o.pickTeam.fpl_id),
    )
    .slice(0, n);
}

// A result that eliminates an LMS entry: anything that isn't a win. A draw OR a
// loss knocks you out — see lms-rules-and-strategy.md.
function isEliminatingResult(result: string | null): boolean {
  if (!result) return false;
  const r = result.toLowerCase();
  return r === "draw" || r === "loss" || r === "lose" || r === "lost";
}

// Build the primary (DB-backed) entry from this user's real lms_picks rows.
// `teamsById` resolves team_id -> Team for badge rendering.
export function buildPrimaryEntry(
  picks: LmsPick[],
  teamsById: Map<number, Team>,
): LmsEntry {
  const entryPicks: LmsEntryPick[] = picks
    .slice()
    .sort((a, b) => a.round_gw - b.round_gw)
    .map((p) => ({
      roundGw: p.round_gw,
      team: p.team_id != null ? (teamsById.get(p.team_id) ?? null) : null,
      result: p.result,
      survived: p.survived,
    }));

  const eliminated = entryPicks.some(
    (p) => p.survived === false || isEliminatingResult(p.result),
  );

  return {
    id: "entry-1",
    label: "Entry 1",
    eliminated,
    picks: entryPicks,
    persisted: true,
  };
}

// Build a second, independent entry. The schema has no per-entry dimension
// (lms_picks PK is (user_id, round_gw)), so a real second entry needs an
// `entry_no` column that isn't built yet. Until then this is a clearly-typed
// placeholder track so the "independent entries" UX is exercised.
// TODO wire: persist multiple entries once lms_picks gains an entry dimension.
export function buildDemoEntry(teamsById: Map<number, Team>): LmsEntry {
  // Seed a couple of spent rounds from real team rows when available, so the
  // used/remaining view is non-trivial. Falls back to an empty history.
  const seedCodes = ["LIV", "ARS"];
  const byCode = new Map<string, Team>();
  for (const t of teamsById.values()) byCode.set(t.short_name, t);

  const picks: LmsEntryPick[] = seedCodes
    .map((code, i): LmsEntryPick | null => {
      const team = byCode.get(code);
      if (!team) return null;
      return { roundGw: i + 1, team, result: "win", survived: true };
    })
    .filter((p): p is LmsEntryPick => p !== null);

  return {
    id: "entry-2",
    label: "Entry 2",
    eliminated: false,
    picks,
    persisted: false,
  };
}

// Ordered team codes for the placeholder forward-plan allocation, biased toward
// traditionally strong sides. Only used to populate provisional picks — the real
// allocation engine will replace this wholesale.
const PLAN_PREFERENCE = [
  "MCI",
  "ARS",
  "LIV",
  "CHE",
  "NEW",
  "TOT",
  "AVL",
  "MUN",
  "BHA",
  "WHU",
];

// Build the next-five-qualifying-rounds forward plan. The *rounds* (which GWs
// qualify vs are skipped for having < 7 fixtures) come from real gameweeks
// rows; the *team allocation, win probabilities and reserved bankers* are
// placeholder logic.
// TODO wire: replace the allocation below with the real forward-plan engine
// (season-long team reservation + model win probabilities).
export function buildForwardPlanPlaceholder(
  upcoming: Gameweek[],
  usedCodes: Set<string>,
  availableTeams: Team[],
): LmsForwardPlan {
  const availableCodes = new Set(availableTeams.map((t) => t.short_name));
  const allocated = new Set<string>(usedCodes);

  const nextCode = (): string | null => {
    for (const code of PLAN_PREFERENCE) {
      if (allocated.has(code)) continue;
      if (availableCodes.size > 0 && !availableCodes.has(code)) continue;
      allocated.add(code);
      return code;
    }
    return null;
  };

  const plan: LmsForwardPlan = [];
  let qualifyingSeen = 0;

  for (const gw of upcoming) {
    if (qualifyingSeen >= 5) break;
    const qualifies = gw.lms_eligible;

    if (!qualifies) {
      // Honest "skipped · under 7" marker — no pick spent this round.
      plan.push({
        round: gw.gw,
        qualifies: false,
        numFixtures: gw.num_fixtures,
        provisionalPick: null,
        winProb: null,
        reason: "Under 7 fixtures — does not count for LMS.",
        reserved: [],
      });
      continue;
    }

    qualifyingSeen += 1;

    // Placeholder: designate the third qualifying round as a "no clean banker"
    // week that instead holds a strong side in reserve for later.
    if (qualifyingSeen === 3) {
      const reserveCode = nextCode() ?? "MCI";
      plan.push({
        round: gw.gw,
        qualifies: true,
        numFixtures: gw.num_fixtures,
        provisionalPick: null,
        winProb: null,
        reason: "No clean banker this week — hold a strong side back.",
        reserved: [
          {
            code: reserveCode,
            isHome: true,
            reason: `holding ${reserveCode} (H) in reserve — no clean banker this week`,
          },
        ],
      });
      continue;
    }

    const code = nextCode();
    // Deterministic-but-fake win prob that eases down over the horizon.
    const winProb = code ? Math.max(0.55, 0.82 - qualifyingSeen * 0.04) : null;
    plan.push({
      round: gw.gw,
      qualifies: true,
      numFixtures: gw.num_fixtures,
      provisionalPick: code ? { code, isHome: qualifyingSeen % 2 === 1 } : null,
      winProb,
      reason: code
        ? "Provisional banker — strongest available side this round."
        : "No unused side projects as a safe win — revisit nearer the deadline.",
      reserved: [],
    });
  }

  return plan;
}
