import type { LmsPickResult } from "./types";

// ─── Pending-pick mutability gate (result-based only) ─────────────────────────
//
// A backed pick may be cancelled or switched at ANY time — before OR after the
// deadline — for as long as it is still pending. The ONLY lock is result-based:
// once auto-resolve settles the pick to 'survived' or 'eliminated' it is fixed.
// There is deliberately NO time/deadline gate here; the app tracks a changeable
// pick, it is not the game's source of truth. This is the correctness core shared
// by the cancelPick / changePick server actions and the competition UI. Pure —
// same input → same output — so it is unit-tested directly and also drives the
// client's control visibility. The server re-runs it against the freshly-loaded
// pick result before any mutation, so it is the authority.

export interface PickMutationInput {
  /** The pick's current result. Only 'pending' picks are mutable. */
  pickResult: LmsPickResult;
}

export type PickMutationGate =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Decide whether a pick on this round may be cancelled or changed. Allowed
 * whenever the pick is still 'pending' — the deadline and round status are
 * irrelevant. Rejected only once the pick has resolved.
 */
export function canMutatePick(input: PickMutationInput): PickMutationGate {
  if (input.pickResult === "pending") return { ok: true };
  return { ok: false, reason: "This round has resolved — the pick is locked." };
}

/**
 * Short label for a locked backed-pick card in the UI (shown only once the pick
 * has resolved, when no change/cancel controls are offered).
 */
export function pickLockLabel(result: LmsPickResult): string {
  if (result === "survived") return "Locked — survived";
  if (result === "eliminated") return "Locked — out";
  // A pending pick is never locked; this branch is defensive only.
  return "Locked";
}

// ─── Change-target validation ─────────────────────────────────────────────────

export interface UsedPick {
  gw: number;
  teamId: number;
}

export type ChangeTargetResult =
  | { ok: true; noop: boolean }
  | { ok: false; reason: string };

/**
 * Validate switching this round's pick to newTeamId, given the entry's existing
 * picks. Rejects a team already spent by the entry in a DIFFERENT round (the
 * unique(entry_id, team_id) constraint). Re-picking the same team for this round
 * is a clean no-op. Pure — the DB write in changePick relies on this decision.
 */
export function validateChangeTarget(
  currentPicks: ReadonlyArray<UsedPick>,
  gw: number,
  newTeamId: number,
): ChangeTargetResult {
  for (const p of currentPicks) {
    if (p.teamId !== newTeamId) continue;
    if (p.gw === gw) return { ok: true, noop: true };
    return { ok: false, reason: "That team is already used by this entry." };
  }
  return { ok: true, noop: false };
}
