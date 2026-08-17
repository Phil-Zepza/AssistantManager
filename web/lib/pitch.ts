// Pure pitch/formation helpers for the squad planner. No DB, no React — shared
// by the client planner and any server code that needs to reason about a
// formation. Formation strings are "DEF-MID-FWD" (a GK is always exactly 1).

import type { Position } from "./types";
import { FORMATION_MAX, FORMATION_MIN, STARTER_COUNT } from "./squad";

// The eight selectable formations, in the order the picker shows them.
export const FORMATIONS = [
  "3-4-3",
  "3-5-2",
  "4-4-2",
  "4-3-3",
  "4-5-1",
  "5-4-1",
  "5-3-2",
  "5-2-3",
] as const;

export type Formation = (typeof FORMATIONS)[number];

export const DEFAULT_FORMATION: Formation = "3-4-3";

// Rows are laid out top→bottom on the pitch in this order.
export const PITCH_ROWS: Position[] = ["GK", "DEF", "MID", "FWD"];

// Starter counts per position for a formation (GK is always 1).
export function formationCounts(formation: Formation): Record<Position, number> {
  const [def, mid, fwd] = formation.split("-").map((n) => Number(n));
  return { GK: 1, DEF: def, MID: mid, FWD: fwd };
}

// True when the string is one of the eight allowed formations.
export function isFormation(value: string): value is Formation {
  return (FORMATIONS as readonly string[]).includes(value);
}

// Derive the formation string from a set of starters-by-position. Returns null
// when the split isn't one of the eight legal formations (e.g. an in-progress,
// not-yet-full XI).
export function formationFromCounts(
  counts: Record<Position, number>,
): Formation | null {
  const candidate = `${counts.DEF}-${counts.MID}-${counts.FWD}`;
  return isFormation(candidate) &&
    counts.GK === 1 &&
    counts.DEF + counts.MID + counts.FWD + counts.GK === STARTER_COUNT
    ? (candidate as Formation)
    : null;
}

// Is a starting-XI position-count legal at all (within FPL formation ranges)?
export function isLegalStarterSplit(counts: Record<Position, number>): boolean {
  return PITCH_ROWS.every(
    (pos) => counts[pos] >= FORMATION_MIN[pos] && counts[pos] <= FORMATION_MAX[pos],
  );
}
