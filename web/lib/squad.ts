// Pure FPL squad rules + validation. No DB, no "use server", no "server-only":
// imported by BOTH the client editor and the server save action so the rules
// live in one place.

import type { Position } from "./types";

export const SQUAD_SIZE = 15;
export const STARTER_COUNT = 11;
export const BENCH_COUNT = 4;

// Exact squad composition (2 GK / 5 DEF / 5 MID / 3 FWD).
export const POSITION_QUOTA: Record<Position, number> = {
  GK: 2,
  DEF: 5,
  MID: 5,
  FWD: 3,
};

export const MAX_PER_CLUB = 3;

// Budget cap in tenths of a million (£100.0m). Enforced as a SOFT warning only.
export const BUDGET_CAP_TENTHS = 1000;

// Valid starting-XI formation ranges (exactly 1 GK always).
export const FORMATION_MIN: Record<Position, number> = {
  GK: 1,
  DEF: 3,
  MID: 2,
  FWD: 1,
};
export const FORMATION_MAX: Record<Position, number> = {
  GK: 1,
  DEF: 5,
  MID: 5,
  FWD: 3,
};

export const POSITION_ORDER: Position[] = ["GK", "DEF", "MID", "FWD"];

// Minimal per-player facts the validator needs.
export interface SquadMember {
  playerId: number;
  position: Position;
  teamId: number | null;
  onBench: boolean;
  isCaptain: boolean;
  isVice: boolean;
}

export function emptyPositionCounts(): Record<Position, number> {
  return { GK: 0, DEF: 0, MID: 0, FWD: 0 };
}

export function countByPosition(
  members: SquadMember[],
): Record<Position, number> {
  const counts = emptyPositionCounts();
  for (const m of members) counts[m.position] += 1;
  return counts;
}

export function countByClub(members: SquadMember[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const m of members) {
    if (m.teamId == null) continue;
    counts.set(m.teamId, (counts.get(m.teamId) ?? 0) + 1);
  }
  return counts;
}

// Returns a list of human-readable validation errors. Empty = valid to save.
// This is the single source of truth for "can this squad be saved?".
export function validateSquad(members: SquadMember[]): string[] {
  const errors: string[] = [];

  if (members.length !== SQUAD_SIZE) {
    errors.push(`Squad must have exactly ${SQUAD_SIZE} players (currently ${members.length}).`);
  }

  // Position quota.
  const posCounts = countByPosition(members);
  for (const pos of POSITION_ORDER) {
    if (posCounts[pos] !== POSITION_QUOTA[pos]) {
      errors.push(
        `Need exactly ${POSITION_QUOTA[pos]} ${pos} (have ${posCounts[pos]}).`,
      );
    }
  }

  // Max 3 per club.
  for (const [teamId, n] of countByClub(members)) {
    if (n > MAX_PER_CLUB) {
      errors.push(`Too many players from one club (${n} > ${MAX_PER_CLUB}).`);
      // one message is enough; avoid spamming per club
      break;
    }
    void teamId;
  }

  // Starter / bench split.
  const starters = members.filter((m) => !m.onBench);
  const bench = members.filter((m) => m.onBench);
  if (members.length === SQUAD_SIZE) {
    if (starters.length !== STARTER_COUNT) {
      errors.push(`Pick exactly ${STARTER_COUNT} starters (have ${starters.length}).`);
    }
    if (bench.length !== BENCH_COUNT) {
      errors.push(`Pick exactly ${BENCH_COUNT} bench players (have ${bench.length}).`);
    }

    // Formation validity of the starting XI.
    if (starters.length === STARTER_COUNT) {
      const sc = countByPosition(starters);
      for (const pos of POSITION_ORDER) {
        if (sc[pos] < FORMATION_MIN[pos] || sc[pos] > FORMATION_MAX[pos]) {
          errors.push(
            `Invalid formation: ${sc[pos]} ${pos} in the XI (allowed ${FORMATION_MIN[pos]}–${FORMATION_MAX[pos]}).`,
          );
        }
      }
    }
  }

  // Captain / vice: exactly one each, both starters, distinct.
  const captains = members.filter((m) => m.isCaptain);
  const vices = members.filter((m) => m.isVice);
  if (captains.length !== 1) {
    errors.push("Pick exactly one captain.");
  } else if (captains[0].onBench) {
    errors.push("Captain must be a starter.");
  }
  if (vices.length !== 1) {
    errors.push("Pick exactly one vice-captain.");
  } else if (vices[0].onBench) {
    errors.push("Vice-captain must be a starter.");
  }
  if (
    captains.length === 1 &&
    vices.length === 1 &&
    captains[0].playerId === vices[0].playerId
  ) {
    errors.push("Captain and vice-captain must be different players.");
  }

  return errors;
}

// Total squad cost in tenths of a million.
export function totalCost(prices: number[]): number {
  return prices.reduce((sum, p) => sum + p, 0);
}
