import type { LmsGameweekFixture, LmsGwStatus } from "./types";

// Just the fields needed to derive round status — accepts the full
// LmsGameweekFixture as well.
export interface StatusFixture {
  kickoff: string | null;
  finished: boolean;
}

export interface DeriveGwStatusInput {
  /** Resolved round deadline (override or computed default), ISO string. */
  deadline: string | null;
  fixtures: ReadonlyArray<StatusFixture>;
  /** Current time in ms (injected so the derivation stays pure/testable). */
  nowMs: number;
}

function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Derive the round's lifecycle status from its deadline and its fixtures'
 * kickoffs + results. Pure: same inputs → same output.
 *
 *   complete      — there are fixtures and every one is finished.
 *   in_progress   — the earliest kickoff has been reached (and not all done).
 *   starting_soon — deadline has passed but no fixture has kicked off yet.
 *   open          — before the deadline (or no deadline known yet).
 *   unknown       — nothing to derive from.
 */
export function deriveGwStatus({
  deadline,
  fixtures,
  nowMs,
}: DeriveGwStatusInput): LmsGwStatus {
  if (fixtures.length === 0) return "unknown";

  if (fixtures.every((f) => f.finished)) return "complete";

  const kickoffs = fixtures
    .map((f) => toMs(f.kickoff))
    .filter((t): t is number => t != null);
  const firstKickoff = kickoffs.length > 0 ? Math.min(...kickoffs) : null;

  if (firstKickoff != null && nowMs >= firstKickoff) return "in_progress";

  const deadlineMs = toMs(deadline);
  if (deadlineMs != null && nowMs >= deadlineMs) return "starting_soon";

  return "open";
}

export const GW_STATUS_LABEL: Record<LmsGwStatus, string> = {
  open: "Open",
  starting_soon: "Starting soon",
  in_progress: "In progress",
  complete: "Complete",
  unknown: "—",
};

// Convenience for callers that already hold LmsGameweekFixture[].
export function deriveGwStatusFromFixtures(
  deadline: string | null,
  fixtures: ReadonlyArray<LmsGameweekFixture>,
  nowMs: number,
): LmsGwStatus {
  return deriveGwStatus({ deadline, fixtures, nowMs });
}
