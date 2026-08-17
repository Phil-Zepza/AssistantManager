// Pure, DB-free LMS forward-plan engine. No `server-only`, no lib/db import — so
// it is trivially unit-testable and safe to call from either server or client
// (the UI recomputes the plan on every override, entirely in the browser).
//
// lib/queries.ts shapes DB rows into these inputs; server actions (app/actions.ts)
// persist ONLY the current-round submitPick into lms_entry_picks. Forward-round
// overrides are provisional `pins` handled here — never persisted, never counted
// as used teams — so the pipeline auto-resolve step can never mistake a planning
// preference for a locked submission.

export type ReserveStrategy = "safest" | "manual" | "smart";

// Flag vocabulary carried on PlannedPick.flags.
export type PlanFlag =
  | "skipped" // sub-7 round: no team spent
  | "needsDeploy" // best available (non-reserved) pick is below the confidence floor
  | "reserveDeployed" // a held elite reserve was deployed this round (smart)
  | "eliteEarly" // an elite was spent while a non-elite >= floor was also available
  | "noPick" // no eligible team plays / is available this round
  | "pinned" // this round uses a user override (provisional, not persisted)
  | "invalidPin"; // a pin was supplied for this round but could not be honoured

export interface PlannerEntryState {
  /** Teams already spent in persisted (submitted) rounds — the only "used" source. */
  usedTeamIds: number[];
  /** Manual reserves (lms_entry_reserves); only excluded from allocation in manual mode. */
  reservedTeamIds: number[];
  strategy: ReserveStrategy;
  /** e.g. 0.65. Must already be Number()-coerced from the numeric column. */
  confidenceFloor: number;
}

export interface PlannerRound {
  gw: number;
  /** gameweeks.lms_eligible (num_fixtures >= 7). Sub-7 rounds are skipped. */
  lmsEligible: boolean;
  numFixtures: number | null;
}

export interface PlannerFixtureProb {
  fixtureId: number;
  gw: number;
  homeTeamId: number; // fixtures.home_team (teams.fpl_id)
  awayTeamId: number; // fixtures.away_team (teams.fpl_id)
  pHome: number | null;
  pDraw: number | null;
  pAway: number | null;
}

export interface PlannerTeam {
  id: number; // teams.fpl_id
  shortName: string; // teams.short_name
  elo: number | null; // teams.elo (persisted rating)
  strengthAttack: number | null; // teams.strength_attack (elite tie-break)
}

/** A provisional, in-memory override for a future round. Never persisted. */
export interface PlannerPin {
  gw: number;
  teamId: number;
}

export interface PlannedPick {
  gw: number;
  teamId: number | null;
  pWin: number | null;
  reason: string;
  flags: PlanFlag[];
}

export interface PlannedReserve {
  teamId: number;
  /** Smart mode: the round this held elite is earmarked to deploy on; null = pocket / manual. */
  targetGw: number | null;
  reason: string;
  source: "manual" | "elite";
}

export interface ForwardPlan {
  picks: PlannedPick[];
  reserves: PlannedReserve[];
}

export interface ComputeForwardPlanInput {
  entryState: PlannerEntryState;
  upcomingRounds: PlannerRound[];
  fixtureProbs: PlannerFixtureProb[];
  teams: PlannerTeam[];
  /** Team ids from computeEliteSet(). Only consulted in smart mode. */
  eliteSet: number[];
  /** Provisional future-round overrides. In-memory only; never persisted. */
  pins?: PlannerPin[];
}

interface TeamWin {
  pWin: number;
  isHome: boolean;
  fixtureId: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Top-n teams by persisted rating. `teams.elo` is the chosen source — it is a
 * persisted per-team rating (real default 1500, updated by the pipeline from
 * finished fixtures), so it is always available and stable. A season-mean-p_home
 * fallback is unnecessary (and worse: model_fixture_probs only holds upcoming
 * fixtures). Tie-break by strength_attack desc, then fpl_id asc for determinism.
 */
export function computeEliteSet(teams: PlannerTeam[], n = 4): number[] {
  return [...teams]
    .sort(
      (a, b) =>
        (b.elo ?? -Infinity) - (a.elo ?? -Infinity) ||
        (b.strengthAttack ?? -Infinity) - (a.strengthAttack ?? -Infinity) ||
        a.id - b.id,
    )
    .slice(0, n)
    .map((t) => t.id);
}

/**
 * Default LMS round deadline = the day before the round's earliest fixture
 * kickoff. Returns an ISO 8601 string (matching the timestamptz-as-string
 * convention in types.ts), or null when the round has no fixtures / kickoffs.
 * The read layer COALESCEs an lms_competition_deadlines override over this.
 */
export function computeDefaultDeadline(
  gw: number,
  fixtures: ReadonlyArray<{ gw: number; kickoff: string | null }>,
): string | null {
  let earliest = Infinity;
  for (const f of fixtures) {
    if (f.gw !== gw || f.kickoff == null) continue;
    const t = new Date(f.kickoff).getTime();
    if (!Number.isNaN(t) && t < earliest) earliest = t;
  }
  if (earliest === Infinity) return null;
  return new Date(earliest - DAY_MS).toISOString();
}

/**
 * Compute the forward plan for an entry. Pure: same inputs -> same output, with
 * no side effects, so the UI can recompute on every pin/override change.
 */
export function computeForwardPlan(input: ComputeForwardPlanInput): ForwardPlan {
  const { entryState, teams, eliteSet } = input;
  const floor = entryState.confidenceFloor;
  const strategy = entryState.strategy;
  const pins = input.pins ?? [];

  const teamById = new Map<number, PlannerTeam>();
  for (const t of teams) teamById.set(t.id, t);
  const eloOf = (id: number): number => teamById.get(id)?.elo ?? -Infinity;
  const shortOf = (id: number): string => teamById.get(id)?.shortName ?? `#${id}`;
  const pct = (p: number): string => `${Math.round(p * 100)}%`;

  // Per-gw best outright win prob per team. A team absent from a gw's inner map
  // simply does not play that gw (blank-GW handling — never surfaced). For a
  // double gameweek we keep the higher-probability fixture.
  const winByGw = new Map<number, Map<number, TeamWin>>();
  const addWin = (
    gw: number,
    teamId: number,
    pWin: number | null,
    isHome: boolean,
    fixtureId: number,
  ): void => {
    if (pWin == null) return;
    let inner = winByGw.get(gw);
    if (!inner) {
      inner = new Map();
      winByGw.set(gw, inner);
    }
    const prev = inner.get(teamId);
    if (!prev || pWin > prev.pWin) inner.set(teamId, { pWin, isHome, fixtureId });
  };
  for (const fp of input.fixtureProbs) {
    addWin(fp.gw, fp.homeTeamId, fp.pHome, true, fp.fixtureId);
    addWin(fp.gw, fp.awayTeamId, fp.pAway, false, fp.fixtureId);
  }

  const rounds = [...input.upcomingRounds].sort((a, b) => a.gw - b.gw);
  const eliteSetIds = new Set(eliteSet);

  // Ranked candidates for a round: teams that play, pass `ok`, sorted pWin desc,
  // tie-break elo desc then id asc.
  const rank = (
    gw: number,
    ok: (teamId: number) => boolean,
  ): Array<{ teamId: number; win: TeamWin }> => {
    const inner = winByGw.get(gw);
    if (!inner) return [];
    const arr: Array<{ teamId: number; win: TeamWin }> = [];
    for (const [teamId, win] of inner) if (ok(teamId)) arr.push({ teamId, win });
    arr.sort(
      (a, b) =>
        b.win.pWin - a.win.pWin ||
        eloOf(b.teamId) - eloOf(a.teamId) ||
        a.teamId - b.teamId,
    );
    return arr;
  };

  // Resolve pins in gw order against a provisional allocation. A pin is valid
  // when its round is eligible, the team plays that round, and the team is not
  // already used/claimed earlier. Valid pins "claim" their team for that round.
  const pinByGw = new Map<number, number>();
  for (const p of pins) pinByGw.set(p.gw, p.teamId);
  const validPins = new Map<number, number>();
  const invalidPinGws = new Set<number>();
  {
    const provisional = new Set<number>(entryState.usedTeamIds);
    for (const r of rounds) {
      const teamId = pinByGw.get(r.gw);
      if (teamId == null) continue;
      const plays = r.lmsEligible && (winByGw.get(r.gw)?.has(teamId) ?? false);
      if (plays && !provisional.has(teamId)) {
        validPins.set(r.gw, teamId);
        provisional.add(teamId);
      } else {
        invalidPinGws.add(r.gw);
      }
    }
  }

  // Single-use set: historical used teams + all valid future pins (reserved out
  // of every round so they survive for their pinned round).
  const allocated = new Set<number>(entryState.usedTeamIds);
  for (const teamId of validPins.values()) allocated.add(teamId);

  const picks: PlannedPick[] = [];
  const reserves: PlannedReserve[] = [];

  const skippedPick = (r: PlannerRound): PlannedPick => ({
    gw: r.gw,
    teamId: null,
    pWin: null,
    reason: "under 7 fixtures — does not count for LMS",
    flags: ["skipped"],
  });

  const emitPin = (gw: number): void => {
    const teamId = validPins.get(gw)!;
    const win = winByGw.get(gw)?.get(teamId);
    picks.push({
      gw,
      teamId,
      pWin: win?.pWin ?? null,
      reason: win
        ? `pinned by you — ${shortOf(teamId)} (${win.isHome ? "H" : "A"}, ${pct(win.pWin)})`
        : `pinned by you — ${shortOf(teamId)}`,
      flags: ["pinned"],
    });
  };

  // Was an elite spent when a still-available non-elite alternative (>= floor)
  // existed this round? `excluded` are teams unavailable as an alternative.
  const eliteEarlyApplies = (
    gw: number,
    teamId: number,
    excluded: Set<number>,
  ): boolean => {
    if (!eliteSetIds.has(teamId)) return false;
    const inner = winByGw.get(gw);
    if (!inner) return false;
    for (const [otherId, win] of inner) {
      if (otherId === teamId || eliteSetIds.has(otherId) || excluded.has(otherId))
        continue;
      if (win.pWin >= floor) return true;
    }
    return false;
  };

  // -------------------- safest / manual (single gw-order sweep) --------------------
  if (strategy !== "smart") {
    const reserved = new Set<number>(
      strategy === "manual" ? entryState.reservedTeamIds : [],
    );
    if (strategy === "manual") {
      for (const teamId of entryState.reservedTeamIds) {
        reserves.push({
          teamId,
          targetGw: null,
          reason: `held in reserve — ${shortOf(teamId)}`,
          source: "manual",
        });
      }
    }

    for (const r of rounds) {
      if (!r.lmsEligible) {
        picks.push(skippedPick(r));
        continue;
      }
      if (validPins.has(r.gw)) {
        emitPin(r.gw);
        continue;
      }
      const hadInvalidPin = invalidPinGws.has(r.gw);

      const best = rank(
        r.gw,
        (id) => !allocated.has(id) && !reserved.has(id),
      )[0];
      if (!best) {
        const flags: PlanFlag[] =
          strategy === "manual" && reserved.size > 0 ? ["needsDeploy"] : ["noPick"];
        if (hadInvalidPin) flags.push("invalidPin");
        picks.push({
          gw: r.gw,
          teamId: null,
          pWin: null,
          reason:
            strategy === "manual" && reserved.size > 0
              ? "no non-reserved side available — deploy a reserve"
              : "no available side plays this round",
          flags,
        });
        continue;
      }

      allocated.add(best.teamId);
      const belowFloor = strategy === "manual" && best.win.pWin < floor;
      const flags: PlanFlag[] = [];
      if (belowFloor) flags.push("needsDeploy");
      if (hadInvalidPin) flags.push("invalidPin");
      if (
        eliteEarlyApplies(r.gw, best.teamId, new Set([...allocated, ...reserved]))
      )
        flags.push("eliteEarly");
      picks.push({
        gw: r.gw,
        teamId: best.teamId,
        pWin: best.win.pWin,
        reason: `${belowFloor ? "below confidence floor — best available" : "safest available side"} — ${shortOf(best.teamId)} (${best.win.isHome ? "H" : "A"}, ${pct(best.win.pWin)})`,
        flags,
      });
    }
    return { picks, reserves };
  }

  // -------------------- smart (two-pass) --------------------
  const eligibleGws = rounds.filter((r) => r.lmsEligible).map((r) => r.gw);

  // Held elites: eliteSet not already used/claimed, with >= 1 HOME fixture in an
  // eligible round of the horizon. Withheld from normal allocation.
  const heldElites = new Set<number>();
  for (const eid of eliteSet) {
    if (allocated.has(eid)) continue; // used historically or claimed by a pin
    let hasHome = false;
    for (const gw of eligibleGws) {
      const w = winByGw.get(gw)?.get(eid);
      if (w && w.isHome) {
        hasHome = true;
        break;
      }
    }
    if (hasHome) heldElites.add(eid);
  }

  // Pass 1 — deploy held elites to the weakest needy (sub-floor) non-pinned rounds
  // first, strongest available elite to the neediest round.
  const needy: Array<{ gw: number; weakness: number }> = [];
  for (const r of rounds) {
    if (!r.lmsEligible || validPins.has(r.gw)) continue;
    const nonElite = rank(
      r.gw,
      (id) => !allocated.has(id) && !heldElites.has(id) && !eliteSetIds.has(id),
    );
    const weakness = nonElite[0]?.win.pWin ?? -1;
    if (weakness < floor) needy.push({ gw: r.gw, weakness });
  }
  needy.sort((a, b) => a.weakness - b.weakness || a.gw - b.gw);

  const deployed = new Map<number, number>(); // gw -> elite teamId
  for (const n of needy) {
    const pick = rank(
      n.gw,
      (id) => heldElites.has(id) && (winByGw.get(n.gw)?.get(id)?.isHome ?? false),
    )[0];
    if (!pick) continue;
    deployed.set(n.gw, pick.teamId);
    heldElites.delete(pick.teamId);
    allocated.add(pick.teamId);
  }

  // Pass 2 — final sweep in gw order.
  for (const r of rounds) {
    if (!r.lmsEligible) {
      picks.push(skippedPick(r));
      continue;
    }
    if (validPins.has(r.gw)) {
      emitPin(r.gw);
      continue;
    }
    const hadInvalidPin = invalidPinGws.has(r.gw);

    const dep = deployed.get(r.gw);
    if (dep != null) {
      const win = winByGw.get(r.gw)?.get(dep);
      const flags: PlanFlag[] = ["reserveDeployed"];
      if (hadInvalidPin) flags.push("invalidPin");
      picks.push({
        gw: r.gw,
        teamId: dep,
        pWin: win?.pWin ?? null,
        reason: `deployed reserve ${shortOf(dep)} (H${win ? `, ${pct(win.pWin)}` : ""}) — weakest round, best non-elite below floor`,
        flags,
      });
      continue;
    }

    const best = rank(
      r.gw,
      (id) => !allocated.has(id) && !heldElites.has(id),
    )[0];
    if (!best) {
      const flags: PlanFlag[] = ["needsDeploy"];
      if (hadInvalidPin) flags.push("invalidPin");
      picks.push({
        gw: r.gw,
        teamId: null,
        pWin: null,
        reason: "no coverable side this round — deploy a reserve",
        flags,
      });
      continue;
    }

    allocated.add(best.teamId);
    const belowFloor = best.win.pWin < floor;
    const flags: PlanFlag[] = [];
    if (belowFloor) flags.push("needsDeploy");
    if (hadInvalidPin) flags.push("invalidPin");
    if (
      eliteEarlyApplies(r.gw, best.teamId, new Set([...allocated, ...heldElites]))
    )
      flags.push("eliteEarly");
    picks.push({
      gw: r.gw,
      teamId: best.teamId,
      pWin: best.win.pWin,
      reason: `${belowFloor ? "below confidence floor — best available" : "best available side"} — ${shortOf(best.teamId)} (${best.win.isHome ? "H" : "A"}, ${pct(best.win.pWin)})`,
      flags,
    });
  }

  // Reserves output: deployed elites (with their target round) + still-held elites.
  for (const [gw, teamId] of deployed) {
    reserves.push({
      teamId,
      targetGw: gw,
      reason: `elite ${shortOf(teamId)} held then deployed at GW${gw}`,
      source: "elite",
    });
  }
  for (const teamId of heldElites) {
    reserves.push({
      teamId,
      targetGw: null,
      reason: `elite held in reserve — ${shortOf(teamId)}`,
      source: "elite",
    });
  }
  reserves.sort(
    (a, b) => (a.targetGw ?? Infinity) - (b.targetGw ?? Infinity) || a.teamId - b.teamId,
  );

  return { picks, reserves };
}
