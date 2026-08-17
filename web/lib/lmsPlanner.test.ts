import { describe, it, expect } from "vitest";
import {
  computeForwardPlan,
  computeEliteSet,
  computeDefaultDeadline,
  type PlannerTeam,
  type PlannerRound,
  type PlannerFixtureProb,
  type PlannerEntryState,
  type PlannedPick,
} from "./lmsPlanner";

// ---------- builders ----------

function team(id: number, shortName: string, elo: number, sa = elo): PlannerTeam {
  return { id, shortName, elo, strengthAttack: sa };
}

// A small league. Elite-4 by elo = [1, 2, 3, 4].
const TEAMS: PlannerTeam[] = [
  team(1, "MCI", 1600),
  team(2, "ARS", 1580),
  team(3, "LIV", 1560),
  team(4, "CHE", 1540),
  team(5, "NEW", 1500),
  team(6, "AVL", 1480),
  team(7, "BUR", 1300),
  team(8, "SHU", 1280),
];
const ELITE = computeEliteSet(TEAMS, 4); // [1,2,3,4]

function round(gw: number, lmsEligible = true, numFixtures = 10): PlannerRound {
  return { gw, lmsEligible, numFixtures };
}

let fixtureSeq = 1000;
function prob(
  gw: number,
  home: number,
  away: number,
  pHome: number,
  pAway: number,
): PlannerFixtureProb {
  return {
    fixtureId: fixtureSeq++,
    gw,
    homeTeamId: home,
    awayTeamId: away,
    pHome,
    pDraw: Math.max(0, Number((1 - pHome - pAway).toFixed(3))),
    pAway,
  };
}

function state(overrides: Partial<PlannerEntryState> = {}): PlannerEntryState {
  return {
    usedTeamIds: [],
    reservedTeamIds: [],
    strategy: "safest",
    confidenceFloor: 0.65,
    ...overrides,
  };
}

function byGw(picks: PlannedPick[]): Map<number, PlannedPick> {
  return new Map(picks.map((p) => [p.gw, p]));
}

// ---------- safest ----------

describe("safest", () => {
  it("takes the highest win-prob available team each round; single-use holds", () => {
    const rounds = [round(1), round(2)];
    const probs = [
      prob(1, 1, 7, 0.85, 0.08),
      prob(1, 5, 8, 0.7, 0.15),
      prob(2, 1, 8, 0.8, 0.1),
      prob(2, 5, 7, 0.72, 0.14),
    ];
    const { picks } = computeForwardPlan({
      entryState: state(),
      upcomingRounds: rounds,
      fixtureProbs: probs,
      teams: TEAMS,
      eliteSet: ELITE,
    });
    const g = byGw(picks);
    expect(g.get(1)?.teamId).toBe(1);
    expect(g.get(2)?.teamId).toBe(5); // team 1 already spent in gw1
  });

  it("excludes a strong team that does not play the round (blank-GW)", () => {
    // Team 1 (elite, strongest) has no fixture in gw1; only team 5 plays.
    const { picks } = computeForwardPlan({
      entryState: state(),
      upcomingRounds: [round(1)],
      fixtureProbs: [prob(1, 5, 7, 0.72, 0.14)],
      teams: TEAMS,
      eliteSet: ELITE,
    });
    expect(byGw(picks).get(1)?.teamId).toBe(5);
  });
});

// ---------- manual ----------

describe("manual", () => {
  it("never allocates a reserved team and surfaces it as a reserve", () => {
    const { picks, reserves } = computeForwardPlan({
      entryState: state({ strategy: "manual", reservedTeamIds: [1] }),
      upcomingRounds: [round(1)],
      fixtureProbs: [prob(1, 1, 7, 0.85, 0.08), prob(1, 5, 8, 0.7, 0.15)],
      teams: TEAMS,
      eliteSet: ELITE,
    });
    expect(byGw(picks).get(1)?.teamId).toBe(5);
    expect(reserves).toContainEqual(
      expect.objectContaining({ teamId: 1, source: "manual", targetGw: null }),
    );
  });

  it("flags needsDeploy when the best non-reserved pick is below the floor", () => {
    const { picks } = computeForwardPlan({
      entryState: state({ strategy: "manual", reservedTeamIds: [1, 2] }),
      upcomingRounds: [round(1)],
      fixtureProbs: [prob(1, 1, 2, 0.85, 0.08), prob(1, 7, 8, 0.5, 0.2)],
      teams: TEAMS,
      eliteSet: ELITE,
    });
    const p = byGw(picks).get(1)!;
    expect(p.teamId).toBe(7);
    expect(p.flags).toContain("needsDeploy");
  });

  it("returns no pick + needsDeploy when only reserved teams play", () => {
    const { picks } = computeForwardPlan({
      entryState: state({ strategy: "manual", reservedTeamIds: [1, 2] }),
      upcomingRounds: [round(1)],
      fixtureProbs: [prob(1, 1, 2, 0.85, 0.08)],
      teams: TEAMS,
      eliteSet: ELITE,
    });
    const p = byGw(picks).get(1)!;
    expect(p.teamId).toBeNull();
    expect(p.flags).toContain("needsDeploy");
  });
});

// ---------- smart ----------

describe("smart", () => {
  it("holds an elite home fixture and deploys it on the sub-floor round", () => {
    // gw1: strong non-elite (>= floor); gw2: weak non-elite (< floor) + elite home.
    const rounds = [round(1), round(2)];
    const probs = [
      prob(1, 5, 7, 0.75, 0.15),
      prob(1, 6, 8, 0.7, 0.18),
      prob(2, 1, 7, 0.9, 0.05), // elite team 1 at HOME
      prob(2, 8, 6, 0.4, 0.3), // best non-elite here is 0.40 (< floor)
    ];
    const { picks, reserves } = computeForwardPlan({
      entryState: state({ strategy: "smart" }),
      upcomingRounds: rounds,
      fixtureProbs: probs,
      teams: TEAMS,
      eliteSet: ELITE,
    });
    const g = byGw(picks);
    expect(g.get(1)?.teamId).toBe(5); // non-elite used; elite withheld
    expect(g.get(1)?.flags).not.toContain("reserveDeployed");
    expect(g.get(2)?.teamId).toBe(1); // elite deployed on weak round
    expect(g.get(2)?.flags).toContain("reserveDeployed");
    expect(reserves).toContainEqual(
      expect.objectContaining({ teamId: 1, targetGw: 2, source: "elite" }),
    );
  });

  it("assigns the single held elite to the strictly weaker of two sub-floor rounds", () => {
    const rounds = [round(1), round(2)];
    const probs = [
      prob(1, 1, 7, 0.88, 0.06), // elite home gw1
      prob(1, 5, 8, 0.55, 0.2), // non-elite 0.55 (< floor)
      prob(2, 1, 8, 0.85, 0.08), // elite home gw2 too
      prob(2, 6, 7, 0.45, 0.25), // non-elite 0.45 (weaker)
    ];
    const { picks } = computeForwardPlan({
      entryState: state({ strategy: "smart" }),
      upcomingRounds: rounds,
      fixtureProbs: probs,
      teams: TEAMS,
      eliteSet: ELITE,
    });
    const g = byGw(picks);
    expect(g.get(2)?.teamId).toBe(1); // deployed on the weaker round (gw2)
    expect(g.get(2)?.flags).toContain("reserveDeployed");
    expect(g.get(1)?.teamId).toBe(5); // elite no longer available in gw1
    expect(g.get(1)?.flags).toContain("needsDeploy");
  });

  it("flags needsDeploy on a sub-floor round with no held elite available", () => {
    const { picks } = computeForwardPlan({
      entryState: state({ strategy: "smart" }),
      upcomingRounds: [round(1)],
      // elites never play -> nothing held; only weak teams available
      fixtureProbs: [prob(1, 7, 8, 0.4, 0.3)],
      teams: TEAMS,
      eliteSet: ELITE,
    });
    const p = byGw(picks).get(1)!;
    expect(p.teamId).toBe(7);
    expect(p.flags).toContain("needsDeploy");
  });
});

// ---------- eliteEarly ----------

describe("eliteEarly", () => {
  it("flags spending an elite when a non-elite also cleared the floor (safest)", () => {
    const { picks } = computeForwardPlan({
      entryState: state(),
      upcomingRounds: [round(1)],
      fixtureProbs: [prob(1, 1, 7, 0.85, 0.08), prob(1, 5, 8, 0.7, 0.15)],
      teams: TEAMS,
      eliteSet: ELITE,
    });
    const p = byGw(picks).get(1)!;
    expect(p.teamId).toBe(1);
    expect(p.flags).toContain("eliteEarly");
  });

  it("flags a non-held (away-only) elite spent early in smart mode", () => {
    const { picks } = computeForwardPlan({
      entryState: state({ strategy: "smart" }),
      upcomingRounds: [round(1)],
      // elite team 1 only AWAY (never held); non-elite team 5 clears the floor
      fixtureProbs: [prob(1, 7, 1, 0.1, 0.8), prob(1, 5, 8, 0.7, 0.15)],
      teams: TEAMS,
      eliteSet: ELITE,
    });
    const p = byGw(picks).get(1)!;
    expect(p.teamId).toBe(1);
    expect(p.flags).toContain("eliteEarly");
  });
});

// ---------- single-use ----------

describe("single-use", () => {
  it("never reuses a team across rounds, and honours historical usedTeamIds", () => {
    const rounds = [round(1), round(2), round(3)];
    const probs = [
      prob(1, 5, 7, 0.8, 0.12),
      prob(3, 5, 8, 0.85, 0.1), // team 5 tops gw3 too
      prob(3, 6, 7, 0.7, 0.18),
    ];
    const g1 = byGw(
      computeForwardPlan({
        entryState: state(),
        upcomingRounds: rounds,
        fixtureProbs: probs,
        teams: TEAMS,
        eliteSet: ELITE,
      }).picks,
    );
    expect(g1.get(1)?.teamId).toBe(5);
    expect(g1.get(3)?.teamId).toBe(6); // team 5 already spent in gw1

    // Seeded as historically used -> team 5 must never appear.
    const g2 = computeForwardPlan({
      entryState: state({ usedTeamIds: [5] }),
      upcomingRounds: [round(1)],
      fixtureProbs: [prob(1, 5, 7, 0.8, 0.12), prob(1, 6, 8, 0.6, 0.2)],
      teams: TEAMS,
      eliteSet: ELITE,
    }).picks;
    expect(g2.every((p) => p.teamId !== 5)).toBe(true);
    expect(byGw(g2).get(1)?.teamId).toBe(6);
  });
});

// ---------- sub-7 skip ----------

describe("sub-7 skip", () => {
  it("returns a skipped round that spends no team", () => {
    const rounds = [round(1), round(2, false), round(3)];
    const probs = [
      prob(1, 6, 8, 0.75, 0.15),
      prob(2, 5, 7, 0.95, 0.03), // best overall but the round is skipped
      prob(3, 5, 7, 0.8, 0.12),
    ];
    const g = byGw(
      computeForwardPlan({
        entryState: state(),
        upcomingRounds: rounds,
        fixtureProbs: probs,
        teams: TEAMS,
        eliteSet: ELITE,
      }).picks,
    );
    expect(g.get(2)?.teamId).toBeNull();
    expect(g.get(2)?.flags).toEqual(["skipped"]);
    // team 5 was NOT consumed by the skipped gw2, so it is still available in gw3
    expect(g.get(3)?.teamId).toBe(5);
  });
});

// ---------- pins (provisional override -> live recompute) ----------

describe("pins", () => {
  const rounds = [round(1), round(2), round(3)];
  const probs = [
    prob(1, 5, 8, 0.8, 0.12),
    prob(2, 5, 6, 0.85, 0.1),
    prob(2, 6, 5, 0.72, 0.15), // (team 6 also plays gw2)
    prob(2, 7, 8, 0.6, 0.2), // team 7 plays gw2
    prob(3, 6, 7, 0.75, 0.15),
    prob(3, 7, 6, 0.65, 0.2),
  ];

  it("recomputes downstream when a future round is pinned; pin is not persisted", () => {
    const base = byGw(
      computeForwardPlan({
        entryState: state(),
        upcomingRounds: rounds,
        fixtureProbs: probs,
        teams: TEAMS,
        eliteSet: ELITE,
      }).picks,
    );
    // Without a pin, gw3's best available is team 7.
    expect(base.get(3)?.teamId).toBe(7);

    const pinned = byGw(
      computeForwardPlan({
        entryState: state(),
        upcomingRounds: rounds,
        fixtureProbs: probs,
        teams: TEAMS,
        eliteSet: ELITE,
        pins: [{ gw: 2, teamId: 7 }],
      }).picks,
    );
    expect(pinned.get(2)?.teamId).toBe(7);
    expect(pinned.get(2)?.flags).toContain("pinned");
    // team 7 is now claimed for gw2, so gw3 reallocates to team 6.
    expect(pinned.get(3)?.teamId).toBe(6);
  });

  it("marks an unplayable pin invalid and falls back to the normal pick", () => {
    const g = byGw(
      computeForwardPlan({
        entryState: state(),
        upcomingRounds: [round(1)],
        fixtureProbs: [prob(1, 5, 7, 0.8, 0.12), prob(1, 6, 8, 0.7, 0.16)],
        teams: TEAMS,
        eliteSet: ELITE,
        pins: [{ gw: 1, teamId: 99 }], // team 99 does not play
      }).picks,
    );
    const p = g.get(1)!;
    expect(p.teamId).toBe(5);
    expect(p.flags).toContain("invalidPin");
  });
});

// ---------- computeEliteSet ----------

describe("computeEliteSet", () => {
  it("ranks by elo, breaks ties by strengthAttack then id, and respects n", () => {
    const ts: PlannerTeam[] = [
      team(1, "A", 1500, 10),
      team(2, "B", 1500, 20),
      team(3, "C", 1600, 5),
      team(4, "D", 1400, 1),
      team(5, "E", 1550, 1),
    ];
    expect(computeEliteSet(ts, 4)).toEqual([3, 5, 2, 1]);
    expect(computeEliteSet(ts, 2)).toEqual([3, 5]);
  });
});

// ---------- computeDefaultDeadline ----------

describe("computeDefaultDeadline", () => {
  const fixtures = [
    { gw: 1, kickoff: "2025-08-16T14:00:00.000Z" },
    { gw: 1, kickoff: "2025-08-15T19:00:00.000Z" }, // earliest for gw1
    { gw: 2, kickoff: "2025-08-10T12:00:00.000Z" }, // other gw, ignored for gw1
  ];

  it("returns the day before the earliest kickoff of that gw", () => {
    expect(computeDefaultDeadline(1, fixtures)).toBe("2025-08-14T19:00:00.000Z");
  });

  it("returns null when the gw has no fixtures or no kickoffs", () => {
    expect(computeDefaultDeadline(3, fixtures)).toBeNull();
    expect(computeDefaultDeadline(1, [{ gw: 1, kickoff: null }])).toBeNull();
  });
});
