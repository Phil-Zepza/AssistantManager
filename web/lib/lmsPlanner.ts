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

// ============================================================================
// Cross-entry variance — "Spread picks across entries" (computeCompetitionPlan)
// ============================================================================
//
// A competition holds multiple entries (lives). Backing the same team in the same
// round across entries means one freak result can eliminate them all at once.
// computeCompetitionPlan allocates JOINTLY across the alive entries per qualifying
// round so each entry gets a distinct team where possible. It COMPOSES with the
// per-entry engine above: `off` mode (and every sub-7 round, and each entry's
// reserves output) is delegated straight to computeForwardPlan, so PR A behaviour
// is reproduced exactly; the soft/strong coordination only changes WHICH team each
// entry is handed per qualifying round. Each entry's own used-teams + reserves
// still gate its candidate pool.
//
// Pure + side-effect free (same inputs -> same output), so PR D can re-run it in
// the browser on every override. Nothing persists until submitPick locks a round.

export type SpreadMode = "off" | "soft" | "strong";
export type SpreadSource = "spread" | "matched" | null;

/**
 * Auto-Soft default: adding an entry that takes a competition from 1 -> 2 entries
 * flips an untouched ('off') competition to 'soft'. Pure so actions.ts and its test
 * share one rule. Never lowers an explicit 'soft'/'strong' choice, and fires only at
 * exactly 2 entries — so re-running at 3+ entries is a no-op (idempotent).
 */
export function autoSoftApplies(
  entryCountAfterInsert: number,
  currentMode: SpreadMode,
): boolean {
  return entryCountAfterInsert === 2 && currentMode === "off";
}

/** A per-round "same team across entries" override (lms_competition_spread_overrides). */
export interface SpreadOverride {
  gw: number;
  forceSame: boolean;
}

/** One alive entry's planner state for the joint pass. */
export interface CompetitionEntryInput {
  entryId: number;
  entryState: PlannerEntryState;
  /** Provisional future-round overrides; honoured only via the off-mode delegation. */
  pins?: PlannerPin[];
}

export interface ComputeCompetitionPlanInput {
  /** All ALIVE entries. Ordered deterministically by entryId inside the engine. */
  entries: CompetitionEntryInput[];
  upcomingRounds: PlannerRound[];
  fixtureProbs: PlannerFixtureProb[];
  teams: PlannerTeam[];
  eliteSet: number[];
  spreadMode: SpreadMode;
  /** Competition Soft floor (default 0.65). Used per entry when its own floor is not finite. */
  spreadFloorSoft: number;
  overrides?: SpreadOverride[];
}

export interface SpreadPlannedPick extends PlannedPick {
  entryId: number;
  spreadSource: SpreadSource;
  /** True when the pick was pinned manually by the user and bypassed joint spread allocation. */
  manualOverride?: boolean;
}

export interface CompetitionEntryPlan {
  entryId: number;
  picks: SpreadPlannedPick[];
  /** Reserves come from the per-entry engine (spread never reshapes reserves). */
  reserves: PlannedReserve[];
}

export interface CompetitionPlan {
  entries: CompetitionEntryPlan[];
  /** GWs the Soft pass auto-collapsed — the caller persists these as force_same overrides. */
  autoCollapsedGws: number[];
}

export function computeCompetitionPlan(
  input: ComputeCompetitionPlanInput,
): CompetitionPlan {
  const { spreadMode, teams } = input;

  const teamById = new Map<number, PlannerTeam>();
  for (const t of teams) teamById.set(t.id, t);
  const eloOf = (id: number): number => teamById.get(id)?.elo ?? -Infinity;
  const shortOf = (id: number): string => teamById.get(id)?.shortName ?? `#${id}`;
  const pct = (p: number): string => `${Math.round(p * 100)}%`;

  // Per-gw best outright win prob per team — identical construction to
  // computeForwardPlan (double GW keeps the higher-probability fixture).
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

  const rounds = [...input.upcomingRounds].sort((a, b) => a.gw - b.gw);
  const overrideByGw = new Map<number, boolean>();
  for (const o of input.overrides ?? []) overrideByGw.set(o.gw, o.forceSame);

  // Deterministic entry order (created order == ascending id).
  const entries = [...input.entries].sort((a, b) => a.entryId - b.entryId);

  // Per-entry PR A plan — the source of truth for off-mode picks, sub-7 skip rows
  // and reserves. Also used as the pure-safest reference only for off mode.
  const basePlanByEntry = new Map<number, ForwardPlan>();
  for (const e of entries) {
    basePlanByEntry.set(
      e.entryId,
      computeForwardPlan({
        entryState: e.entryState,
        upcomingRounds: input.upcomingRounds,
        fixtureProbs: input.fixtureProbs,
        teams,
        eliteSet: input.eliteSet,
        pins: e.pins,
      }),
    );
  }
  const basePickAt = (entryId: number, gw: number): PlannedPick | undefined => {
    for (const p of basePlanByEntry.get(entryId)!.picks) if (p.gw === gw) return p;
    return undefined;
  };

  // Fast path: off + no active override => straight PR A passthrough.
  const hasForceSame = (input.overrides ?? []).some((o) => o.forceSame);
  if (spreadMode === "off" && !hasForceSame) {
    return {
      entries: entries.map((e) => ({
        entryId: e.entryId,
        picks: basePlanByEntry.get(e.entryId)!.picks.map((p) => ({
          ...p,
          entryId: e.entryId,
          spreadSource: null as SpreadSource,
        })),
        reserves: basePlanByEntry.get(e.entryId)!.reserves,
      })),
      autoCollapsedGws: [],
    };
  }

  // ---- Coordinated sweep state ----
  const allocatedByEntry = new Map<number, Set<number>>(); // single-use across the plan
  const reservedByEntry = new Map<number, Set<number>>(); // manual reserves only (mirrors PR A)
  const floorByEntry = new Map<number, number>();
  const picksByEntry = new Map<number, SpreadPlannedPick[]>();
  for (const e of entries) {
    allocatedByEntry.set(e.entryId, new Set(e.entryState.usedTeamIds));
    reservedByEntry.set(
      e.entryId,
      new Set(e.entryState.strategy === "manual" ? e.entryState.reservedTeamIds : []),
    );
    const cf = e.entryState.confidenceFloor;
    floorByEntry.set(e.entryId, Number.isFinite(cf) ? cf : input.spreadFloorSoft);
    picksByEntry.set(e.entryId, []);
  }

  const candidatesFor = (
    entryId: number,
    gw: number,
  ): Array<{ teamId: number; win: TeamWin }> =>
    rank(
      gw,
      (id) =>
        !allocatedByEntry.get(entryId)!.has(id) &&
        !reservedByEntry.get(entryId)!.has(id),
    );

  // Emit one pick for an entry, deriving flags/reason consistently with PR A.
  const emit = (
    entryId: number,
    gw: number,
    teamId: number | null,
    spreadSource: SpreadSource,
    lead: string, // reason lead-in, e.g. "distinct side to spread risk"
  ): void => {
    if (teamId != null) allocatedByEntry.get(entryId)!.add(teamId);
    const win = teamId != null ? winByGw.get(gw)?.get(teamId) : undefined;
    const pWin = win?.pWin ?? null;
    const floor = floorByEntry.get(entryId)!;
    const flags: PlanFlag[] = [];
    if (teamId == null) flags.push("noPick");
    else if (pWin != null && pWin < floor) flags.push("needsDeploy");
    const reason =
      teamId == null
        ? "no available side plays this round"
        : `${lead} — ${shortOf(teamId)} (${win?.isHome ? "H" : "A"}${
            pWin != null ? `, ${pct(pWin)}` : ""
          })`;
    picksByEntry
      .get(entryId)!
      .push({ gw, teamId, pWin, reason, flags, entryId, spreadSource });
  };

  // Collapse a round: every entry in `entrySubset` backs one team (tagged matched).
  // `preferred` is the intended team (Soft's single floor-clearer); otherwise pick
  // the safest team available to every entry in the subset. `preAssigned` contains
  // teams already taken by pinned entries this round — excluded from the common pool.
  const collapseRound = (
    gw: number,
    preferred?: number,
    entrySubset: typeof entries = entries,
    preAssigned: ReadonlySet<number> = new Set(),
  ): void => {
    const availableToAll = (id: number): boolean =>
      !preAssigned.has(id) &&
      entrySubset.every(
        (e) =>
          !allocatedByEntry.get(e.entryId)!.has(id) &&
          !reservedByEntry.get(e.entryId)!.has(id),
      );
    let chosen: number | null = null;
    if (
      preferred != null &&
      (winByGw.get(gw)?.has(preferred) ?? false) &&
      availableToAll(preferred)
    ) {
      chosen = preferred;
    } else {
      for (const c of rank(gw, () => true)) {
        if (availableToAll(c.teamId)) {
          chosen = c.teamId;
          break;
        }
      }
    }
    for (const e of entrySubset) {
      if (
        chosen != null &&
        !allocatedByEntry.get(e.entryId)!.has(chosen) &&
        !reservedByEntry.get(e.entryId)!.has(chosen)
      ) {
        emit(e.entryId, gw, chosen, "matched", "same team across entries");
      } else {
        const solo = candidatesFor(e.entryId, gw)[0];
        emit(
          e.entryId,
          gw,
          solo?.teamId ?? null,
          solo ? "matched" : null,
          "same team across entries (own safest — common team unavailable)",
        );
      }
    }
  };

  // Greedy distinct allocation for one round. `useFloor` gates Soft to floor-clearing
  // candidates; Strong hands out the next-best distinct candidate however low.
  // `entrySubset` restricts allocation to a subset of entries (used when some entries
  // have been handled via manual pins). `preAssigned` seeds the round's "taken" set so
  // pinned teams are not re-allocated to coordinated entries.
  const allocateDistinct = (
    gw: number,
    useFloor: boolean,
    entrySubset: typeof entries = entries,
    preAssigned: ReadonlySet<number> = new Set(),
  ): void => {
    const assigned = new Set<number>(preAssigned);
    for (const e of entrySubset) {
      const floor = floorByEntry.get(e.entryId)!;
      const cands = candidatesFor(e.entryId, gw);
      const solo = cands[0]; // the entry's own pure-safest this round
      let pick: { teamId: number; win: TeamWin } | undefined;
      for (const c of cands) {
        if (assigned.has(c.teamId)) continue;
        if (useFloor && c.win.pWin < floor) continue;
        pick = c;
        break;
      }
      if (pick) {
        assigned.add(pick.teamId);
        const source: SpreadSource =
          solo && pick.teamId !== solo.teamId ? "spread" : null;
        emit(
          e.entryId,
          gw,
          pick.teamId,
          source,
          source === "spread" ? "distinct side to spread risk" : "safest available side",
        );
      } else if (solo) {
        // No distinct (floor-clearing) candidate left — take own safest, matched.
        assigned.add(solo.teamId);
        emit(e.entryId, gw, solo.teamId, "matched", "matched sibling — no distinct side");
      } else {
        emit(e.entryId, gw, null, null, "");
      }
    }
  };

  const skippedSpread = (entryId: number, gw: number): void => {
    const base = basePickAt(entryId, gw);
    picksByEntry.get(entryId)!.push({
      gw,
      teamId: null,
      pWin: null,
      reason: base?.reason ?? "under 7 fixtures — does not count for LMS",
      flags: base?.flags ?? (["skipped"] as PlanFlag[]),
      entryId,
      spreadSource: null,
    });
  };

  const autoCollapsedGws: number[] = [];

  for (const r of rounds) {
    if (!r.lmsEligible) {
      for (const e of entries) skippedSpread(e.entryId, r.gw);
      continue;
    }
    const gw = r.gw;

    // Per-round force_same override collapses regardless of mode.
    if (overrideByGw.get(gw) === true) {
      collapseRound(gw);
      continue;
    }

    if (spreadMode === "off") {
      // Non-override off round: follow each entry's PR A pick verbatim.
      for (const e of entries) {
        const base = basePickAt(e.entryId, gw);
        if (base?.teamId != null) allocatedByEntry.get(e.entryId)!.add(base.teamId);
        picksByEntry.get(e.entryId)!.push({
          ...(base ?? {
            gw,
            teamId: null,
            pWin: null,
            reason: "no available side plays this round",
            flags: ["noPick"] as PlanFlag[],
          }),
          entryId: e.entryId,
          spreadSource: null,
        });
      }
      continue;
    }

    // For soft/strong: honor per-entry manual pins before coordinated allocation.
    // A pinned entry is excluded from the joint pool; its team is pre-assigned so
    // coordinated entries won't duplicate it. This is client-side only — no
    // premature persistence; submitPick locks the round when the user confirms.
    const handledEntries = new Set<number>();
    const preAssigned = new Set<number>();
    for (const e of entries) {
      const base = basePickAt(e.entryId, gw);
      if (base != null && base.flags.includes("pinned") && base.teamId != null) {
        allocatedByEntry.get(e.entryId)!.add(base.teamId);
        picksByEntry.get(e.entryId)!.push({
          gw,
          teamId: base.teamId,
          pWin: base.pWin,
          reason: base.reason,
          flags: base.flags,
          entryId: e.entryId,
          spreadSource: null,
          manualOverride: true,
        });
        handledEntries.add(e.entryId);
        preAssigned.add(base.teamId);
      }
    }

    const unhandledEntries = entries.filter((e) => !handledEntries.has(e.entryId));
    if (unhandledEntries.length === 0) continue;

    if (spreadMode === "soft") {
      // Union of teams that clear each entry's floor, excluding already-pinned teams.
      const floorTeams = new Set<number>();
      for (const e of unhandledEntries) {
        const floor = floorByEntry.get(e.entryId)!;
        for (const c of candidatesFor(e.entryId, gw)) {
          if (c.win.pWin >= floor && !preAssigned.has(c.teamId)) floorTeams.add(c.teamId);
        }
      }
      if (floorTeams.size === 1) {
        // Only one team clears the floor for the unhandled entries — auto-collapse them.
        collapseRound(gw, [...floorTeams][0], unhandledEntries, preAssigned);
        autoCollapsedGws.push(gw);
        continue;
      }
      allocateDistinct(gw, true, unhandledEntries, preAssigned);
      continue;
    }

    // strong
    allocateDistinct(gw, false, unhandledEntries, preAssigned);
  }

  return {
    entries: entries.map((e) => ({
      entryId: e.entryId,
      picks: picksByEntry.get(e.entryId)!,
      reserves: basePlanByEntry.get(e.entryId)!.reserves,
    })),
    autoCollapsedGws,
  };
}
