import type { LmsGwStatus, LmsPickResult } from "./types";
import { deriveGwStatus, type StatusFixture } from "./lmsStatus";

// ─── Pending-pick mutability gate ─────────────────────────────────────────────
//
// A backed pick may be cancelled or switched ONLY while its round is still Open
// (before the effective deadline / first kickoff) AND the pick is still pending.
// This is the correctness core shared by the cancelPick / changePick server
// actions and the competition UI. Pure — same inputs → same output — so it is
// unit-tested directly and can also drive the client's control visibility. The
// server re-runs it against freshly-loaded data before any mutation, so a client
// that renders a control it shouldn't (render-vs-deadline race) is still refused.

export interface PickMutationInput {
  /** Effective round deadline (override or computed default), ISO string. */
  deadline: string | null;
  /** The round's fixtures (kickoff + finished), for status derivation. */
  fixtures: ReadonlyArray<StatusFixture>;
  /** Current time in ms (injected so the gate stays pure/testable). */
  nowMs: number;
  /** The pick's current result. Only 'pending' picks are mutable. */
  pickResult: LmsPickResult;
}

export type PickMutationGate =
  | { ok: true }
  | { ok: false; reason: string };

// User-facing refusal messages. A resolved pick takes precedence over the round
// status (a settled pick is locked no matter what the clock says).
function lockedReason(status: LmsGwStatus, result: LmsPickResult): string {
  if (result === "survived") {
    return "This pick has already survived — it can't be changed.";
  }
  if (result === "eliminated") {
    return "This pick has already been settled — it can't be changed.";
  }
  switch (status) {
    case "starting_soon":
      return "This round's deadline has passed — your pick is locked.";
    case "in_progress":
      return "This round has started — your pick is locked.";
    case "complete":
      return "This round is over — your pick is locked.";
    default:
      return "This round is not open — your pick is locked.";
  }
}

/**
 * Decide whether a pending pick on this round may be cancelled or changed.
 * Allowed only when the round derives to "open" AND the pick is "pending".
 */
export function canMutatePick(input: PickMutationInput): PickMutationGate {
  const status = deriveGwStatus({
    deadline: input.deadline,
    fixtures: input.fixtures,
    nowMs: input.nowMs,
  });
  if (status === "open" && input.pickResult === "pending") return { ok: true };
  return { ok: false, reason: lockedReason(status, input.pickResult) };
}

/**
 * Short label for a locked backed-pick card in the UI (no change/cancel
 * controls). Mirrors canMutatePick's reasoning but phrased as a status chip.
 */
export function pickLockLabel(
  status: LmsGwStatus,
  result: LmsPickResult,
): string {
  if (result === "survived") return "Locked — survived";
  if (result === "eliminated") return "Locked — out";
  switch (status) {
    case "starting_soon":
      return "Locked — the deadline has passed";
    case "in_progress":
      return "Locked — the round has started";
    case "complete":
      return "Locked — the round is over";
    default:
      return "Locked";
  }
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
