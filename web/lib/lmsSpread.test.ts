import { describe, it, expect } from "vitest";
import {
  computeCompetitionPlan,
  computeForwardPlan,
  computeEliteSet,
  autoSoftApplies,
  type PlannerTeam,
  type PlannerRound,
  type PlannerFixtureProb,
  type PlannerEntryState,
  type CompetitionEntryInput,
  type ComputeCompetitionPlanInput,
  type CompetitionPlan,
  type SpreadMode,
  type SpreadOverride,
  type PlannerCompetition,
} from "./lmsPlanner";

// ---------- builders (mirrors lmsPlanner.test.ts) ----------

function team(id: number, shortName: string, elo: number, sa = elo): PlannerTeam {
  return { id, shortName, elo, strengthAttack: sa };
}

// Elo strictly descending by id so the pWin tie-break is deterministic.
const TEAMS: PlannerTeam[] = [
  team(1, "MCI", 1600),
  team(2, "ARS", 1580),
  team(3, "LIV", 1560),
  team(4, "CHE", 1540),
  team(5, "NEW", 1520),
  team(6, "AVL", 1500),
  team(7, "BUR", 1300),
  team(8, "SHU", 1280),
];
const ELITE = computeEliteSet(TEAMS, 4);

function round(
  gw: number,
  lmsEligible = true,
  numFixtures = lmsEligible ? 10 : 5,
): PlannerRound {
  return { gw, lmsEligible, numFixtures };
}

let fixtureSeq = 5000;
// A home fixture: `home` plays with win prob `pHome`, `away` with `pAway`.
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

function entry(
  entryId: number,
  o: Partial<PlannerEntryState> = {},
): CompetitionEntryInput {
  return {
    entryId,
    entryState: {
      usedTeamIds: [],
      reservedTeamIds: [],
      strategy: "safest",
      confidenceFloor: 0.65,
      ...o,
    },
  };
}

function compInput(
  o: {
    entries: CompetitionEntryInput[];
    fixtureProbs: PlannerFixtureProb[];
    upcomingRounds?: PlannerRound[];
    spreadMode: SpreadMode;
    spreadFloorSoft?: number;
    overrides?: SpreadOverride[];
    competition?: PlannerCompetition;
  },
): ComputeCompetitionPlanInput {
  return {
    entries: o.entries,
    upcomingRounds: o.upcomingRounds ?? [round(1)],
    fixtureProbs: o.fixtureProbs,
    teams: TEAMS,
    eliteSet: ELITE,
    spreadMode: o.spreadMode,
    spreadFloorSoft: o.spreadFloorSoft ?? 0.65,
    overrides: o.overrides ?? [],
    competition: o.competition,
  };
}

const pickOf = (plan: CompetitionPlan, entryId: number, gw: number) =>
  plan.entries.find((e) => e.entryId === entryId)!.picks.find((p) => p.gw === gw)!;

// ---------- tests ----------

describe("computeCompetitionPlan — Soft", () => {
  it("respects the floor: a below-floor distinct team is NOT chosen — entry falls back to matched", () => {
    // gw1: A 0.80, B 0.72 (both clear 0.65), C 0.55 (below floor).
    // e2 has already used B, so its only floor-clearing option is A (taken by e1);
    // C is below floor and must NOT be handed to e2 — it falls back to A, matched.
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "soft",
        entries: [entry(1), entry(2, { usedTeamIds: [2] })],
        fixtureProbs: [
          prob(1, 1, 7, 0.8, 0.05),
          prob(1, 2, 8, 0.72, 0.08),
          prob(1, 3, 6, 0.55, 0.2),
        ],
      }),
    );
    // Two floor-clearing teams exist across the set -> no auto-collapse.
    expect(plan.autoCollapsedGws).toEqual([]);
    expect(pickOf(plan, 1, 1).teamId).toBe(1); // e1 safest
    expect(pickOf(plan, 1, 1).spreadSource).toBeNull();

    const e2 = pickOf(plan, 2, 1);
    expect(e2.teamId).toBe(1); // fell back to its own safest (duplicate of e1)
    expect(e2.teamId).not.toBe(3); // below-floor C was NOT chosen
    expect(e2.spreadSource).toBe("matched");
  });

  it("auto-collapses when exactly one team clears the floor: all matched + records a force_same gw", () => {
    // gw1: only A clears 0.65; B/C below floor for everyone.
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "soft",
        entries: [entry(1), entry(2)],
        fixtureProbs: [
          prob(1, 1, 7, 0.8, 0.05),
          prob(1, 2, 8, 0.6, 0.15),
          prob(1, 3, 6, 0.55, 0.2),
        ],
      }),
    );
    expect(plan.autoCollapsedGws).toEqual([1]); // engine reports the collapse to persist
    expect(pickOf(plan, 1, 1).teamId).toBe(1);
    expect(pickOf(plan, 2, 1).teamId).toBe(1);
    expect(pickOf(plan, 1, 1).spreadSource).toBe("matched");
    expect(pickOf(plan, 2, 1).spreadSource).toBe("matched");
  });
});

describe("computeCompetitionPlan — Strong", () => {
  it("assigns a below-floor distinct team (58% side) rather than duplicating, and never auto-collapses", () => {
    // gw1: A 0.80, B 0.58 (below the 0.65 floor). Strong ignores the floor.
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "strong",
        entries: [entry(1), entry(2)],
        fixtureProbs: [prob(1, 1, 7, 0.8, 0.05), prob(1, 2, 8, 0.58, 0.12)],
      }),
    );
    expect(plan.autoCollapsedGws).toEqual([]); // Strong never auto-collapses
    expect(pickOf(plan, 1, 1).teamId).toBe(1);
    expect(pickOf(plan, 1, 1).spreadSource).toBeNull();

    const e2 = pickOf(plan, 2, 1);
    expect(e2.teamId).toBe(2); // took the 58% side to stay distinct
    expect(e2.pWin).toBeCloseTo(0.58, 5);
    expect(e2.spreadSource).toBe("spread");
  });

  it("tags matched ONLY when the pool of distinct candidates is genuinely exhausted", () => {
    // A single fixture => exactly two teams (1 and 2) play; the 3rd entry cannot
    // find a distinct side and must duplicate.
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "strong",
        entries: [entry(1), entry(2), entry(3)],
        fixtureProbs: [prob(1, 1, 2, 0.8, 0.12)],
      }),
    );
    expect(pickOf(plan, 1, 1).spreadSource).toBeNull();
    expect(pickOf(plan, 2, 1).spreadSource).toBe("spread");
    const e3 = pickOf(plan, 3, 1);
    expect(e3.teamId).toBe(1); // fell back to its own safest
    expect(e3.spreadSource).toBe("matched");
  });
});

describe("computeCompetitionPlan — distinctness & gating", () => {
  it("gives 3 entries distinct teams in a round when enough sides clear the floor", () => {
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "soft",
        entries: [entry(1), entry(2), entry(3)],
        fixtureProbs: [
          prob(1, 1, 7, 0.8, 0.05),
          prob(1, 2, 8, 0.72, 0.08),
          prob(1, 3, 6, 0.68, 0.12),
        ],
      }),
    );
    const teams = [1, 2, 3].map((e) => pickOf(plan, e, 1).teamId);
    expect(teams).toEqual([1, 2, 3]); // all distinct
    expect(new Set(teams).size).toBe(3);
    expect(plan.autoCollapsedGws).toEqual([]);
  });

  it("still gates each entry's pool by its own used-teams and (manual) reserves", () => {
    // e1 manual-reserves A(1); e2 has used B(2). Neither may be handed those teams.
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "strong",
        entries: [
          entry(1, { strategy: "manual", reservedTeamIds: [1] }),
          entry(2, { usedTeamIds: [2] }),
        ],
        fixtureProbs: [
          prob(1, 1, 7, 0.8, 0.05), // A
          prob(1, 2, 8, 0.72, 0.08), // B
          prob(1, 3, 6, 0.68, 0.12), // C
          prob(1, 4, 5, 0.6, 0.2), // D
        ],
      }),
    );
    const e1 = pickOf(plan, 1, 1);
    const e2 = pickOf(plan, 2, 1);
    expect(e1.teamId).not.toBe(1); // A is reserved out of e1
    expect(e1.teamId).toBe(2); // e1 safest available = B
    expect(e2.teamId).not.toBe(2); // B is used by e2
    expect(e2.teamId).toBe(1); // e2 safest available = A
  });
});

describe("computeCompetitionPlan — overrides & tagging", () => {
  it("force_same override collapses the round regardless of mode (even Strong)", () => {
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "strong", // Strong never auto-collapses...
        entries: [entry(1), entry(2)],
        fixtureProbs: [prob(1, 1, 7, 0.8, 0.05), prob(1, 2, 8, 0.72, 0.08)],
        overrides: [{ gw: 1, forceSame: true }], // ...but the override forces it
      }),
    );
    expect(pickOf(plan, 1, 1).teamId).toBe(1);
    expect(pickOf(plan, 2, 1).teamId).toBe(1);
    expect(pickOf(plan, 1, 1).spreadSource).toBe("matched");
    expect(pickOf(plan, 2, 1).spreadSource).toBe("matched");
    // A manual override is not an engine auto-collapse.
    expect(plan.autoCollapsedGws).toEqual([]);
  });

  it("tags spread_source spread / matched / null within a single round", () => {
    // A single fixture => only teams 1 and 2 play; 3 entries, Strong. e1 gets its
    // own safest (null), e2 a distinct side (spread), e3 has no distinct side (matched).
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "strong",
        entries: [entry(1), entry(2), entry(3)],
        fixtureProbs: [prob(1, 1, 2, 0.8, 0.12)],
      }),
    );
    expect(pickOf(plan, 1, 1).spreadSource).toBeNull();
    expect(pickOf(plan, 2, 1).spreadSource).toBe("spread");
    expect(pickOf(plan, 3, 1).spreadSource).toBe("matched");
  });

  it("clearing an override (forceSame=false) returns the round to mode-driven allocation", () => {
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "strong",
        entries: [entry(1), entry(2)],
        fixtureProbs: [prob(1, 1, 7, 0.8, 0.05), prob(1, 2, 8, 0.72, 0.08)],
        overrides: [{ gw: 1, forceSame: false }], // present but not forcing
      }),
    );
    expect(pickOf(plan, 1, 1).teamId).toBe(1);
    expect(pickOf(plan, 2, 1).teamId).toBe(2); // distinct, not collapsed
  });
});

describe("computeCompetitionPlan — per-entry manual pin (override under spread)", () => {
  // gw1: A(1) 0.80, B(2) 0.72, C(3) 0.68 — all clear the 0.65 floor.
  const fixtureProbs = [
    prob(1, 1, 7, 0.8, 0.05), // A
    prob(1, 2, 8, 0.72, 0.08), // B
    prob(1, 3, 6, 0.68, 0.12), // C
  ];

  it("honours the pinned team for that entry and lets siblings coordinate around it (Soft)", () => {
    // Baseline (no pin): Soft hands e1 its safest A(1), e2 the distinct B(2).
    const baseline = computeCompetitionPlan(
      compInput({ spreadMode: "soft", entries: [entry(1), entry(2)], fixtureProbs }),
    );
    expect(pickOf(baseline, 1, 1).teamId).toBe(1);
    expect(pickOf(baseline, 2, 1).teamId).toBe(2);

    // Now e1 pins C(3) — NOT its natural safest — while spread stays on.
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "soft",
        entries: [
          { ...entry(1), pins: [{ gw: 1, teamId: 3 }] },
          entry(2),
        ],
        fixtureProbs,
      }),
    );

    const pinned = pickOf(plan, 1, 1);
    expect(pinned.teamId).toBe(3); // the joint pass did NOT overwrite the pin
    expect(pinned.manualOverride).toBe(true); // tagged distinctly for the UI
    expect(pinned.spreadSource).toBeNull(); // not Matched / Spread
    expect(pinned.flags).toContain("pinned");

    // The sibling keeps coordinating: it steps around the pinned team, is not
    // handed C(3), and is free to take the now-available safest A(1).
    const sibling = pickOf(plan, 2, 1);
    expect(sibling.teamId).not.toBe(3);
    expect(sibling.teamId).toBe(1);
    expect(sibling.manualOverride).toBeFalsy();
    // Pin + sibling remain distinct teams — spread coordination preserved.
    expect(new Set([pinned.teamId, sibling.teamId]).size).toBe(2);
  });

  it("pins under Strong too, with siblings still allocated distinct sides", () => {
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "strong",
        entries: [
          { ...entry(1), pins: [{ gw: 1, teamId: 3 }] },
          entry(2),
          entry(3),
        ],
        fixtureProbs,
      }),
    );
    const p1 = pickOf(plan, 1, 1);
    expect(p1.teamId).toBe(3);
    expect(p1.manualOverride).toBe(true);
    const p2 = pickOf(plan, 2, 1);
    const p3 = pickOf(plan, 3, 1);
    // Three entries, three distinct teams — the pin took one out of the pool and
    // the other two coordinated around it.
    expect(new Set([p1.teamId, p2.teamId, p3.teamId]).size).toBe(3);
    expect(p2.teamId).not.toBe(3);
    expect(p3.teamId).not.toBe(3);
  });
});

describe("computeCompetitionPlan — Off reproduces PR A", () => {
  it("off mode reproduces per-entry computeForwardPlan exactly (incl. smart), no tagging", () => {
    const upcomingRounds = [round(1), round(2), round(3)];
    const fixtureProbs = [
      // gw1
      prob(1, 1, 7, 0.8, 0.05),
      prob(1, 2, 8, 0.7, 0.1),
      prob(1, 3, 6, 0.6, 0.2),
      // gw2
      prob(2, 1, 8, 0.75, 0.08),
      prob(2, 2, 7, 0.68, 0.12),
      prob(2, 4, 5, 0.62, 0.2),
      // gw3
      prob(3, 3, 7, 0.72, 0.1),
      prob(3, 5, 8, 0.66, 0.14),
    ];
    const entries = [
      entry(1, { strategy: "smart" }),
      entry(2, { strategy: "smart", usedTeamIds: [1] }),
    ];

    const plan = computeCompetitionPlan(
      compInput({ spreadMode: "off", entries, upcomingRounds, fixtureProbs }),
    );

    for (const e of entries) {
      const solo = computeForwardPlan({
        entryState: e.entryState,
        upcomingRounds,
        fixtureProbs,
        teams: TEAMS,
        eliteSet: ELITE,
      });
      const jointPicks = plan.entries.find((x) => x.entryId === e.entryId)!.picks;
      // Same team + prob + flags per round as the standalone PR A engine.
      expect(jointPicks.map((p) => [p.gw, p.teamId, p.pWin])).toEqual(
        solo.picks.map((p) => [p.gw, p.teamId, p.pWin]),
      );
      expect(jointPicks.map((p) => p.flags)).toEqual(solo.picks.map((p) => p.flags));
      // Off never tags spread provenance.
      expect(jointPicks.every((p) => p.spreadSource === null)).toBe(true);
    }
  });
});

describe("computeCompetitionPlan — sub-7 rounds", () => {
  it("skips sub-7 rounds for every entry (no team spent)", () => {
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "soft",
        entries: [entry(1), entry(2)],
        upcomingRounds: [round(1, false, 5), round(2, true, 10)],
        fixtureProbs: [
          prob(1, 1, 7, 0.8, 0.05), // present but round 1 is sub-7
          prob(2, 1, 7, 0.8, 0.05),
          prob(2, 2, 8, 0.72, 0.08),
        ],
      }),
    );
    for (const eid of [1, 2]) {
      const p1 = pickOf(plan, eid, 1);
      expect(p1.teamId).toBeNull();
      expect(p1.flags).toContain("skipped");
      expect(p1.spreadSource).toBeNull();
    }
    // Round 2 still allocates distinct teams.
    expect(pickOf(plan, 1, 2).teamId).toBe(1);
    expect(pickOf(plan, 2, 2).teamId).toBe(2);
  });

  it("routes per-competition skips through the shared helper for every entry", () => {
    const skipComp: PlannerCompetition = {
      autoSkipUnderFixtures: 7,
      skippedRounds: [{ gw: 2, reason: "organiser off week" }],
    };
    const plan = computeCompetitionPlan(
      compInput({
        spreadMode: "soft",
        entries: [entry(1), entry(2)],
        // gw1: qualifies (10). gw2: manually skipped. gw3: auto-skipped (sub-7).
        upcomingRounds: [round(1, true, 10), round(2, true, 10), round(3, false, 5)],
        fixtureProbs: [
          prob(1, 1, 7, 0.8, 0.05),
          prob(1, 2, 8, 0.72, 0.08),
          prob(2, 1, 7, 0.9, 0.05),
          prob(3, 1, 7, 0.9, 0.05),
        ],
        competition: skipComp,
      }),
    );
    for (const eid of [1, 2]) {
      const manual = pickOf(plan, eid, 2);
      expect(manual.teamId).toBeNull();
      expect(manual.flags).toContain("skipped");
      expect(manual.skipKind).toBe("manual");
      expect(manual.reason).toBe("organiser off week");

      const auto = pickOf(plan, eid, 3);
      expect(auto.teamId).toBeNull();
      expect(auto.skipKind).toBe("auto");
    }
    // gw1 still allocates distinct teams across the two entries.
    expect(pickOf(plan, 1, 1).teamId).toBe(1);
    expect(pickOf(plan, 2, 1).teamId).toBe(2);
  });
});

describe("autoSoftApplies — addEntry auto-Soft default", () => {
  it("flips off -> soft on the 2nd entry only, and never lowers an explicit choice", () => {
    expect(autoSoftApplies(2, "off")).toBe(true); // 1 -> 2 entries, untouched
    expect(autoSoftApplies(2, "soft")).toBe(false); // explicit soft left alone
    expect(autoSoftApplies(2, "strong")).toBe(false); // explicit strong left alone
    expect(autoSoftApplies(1, "off")).toBe(false); // first entry: no default yet
    expect(autoSoftApplies(3, "off")).toBe(false); // idempotent: only at exactly 2
  });
});
