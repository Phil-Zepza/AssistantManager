// Pure decision-support projections. Every function here answers a "what if?"
// question with projected points + deltas — NONE of it mutates anything and
// NONE of it writes to FPL. This app never pushes to FPL (no write API exists),
// so a "captain" or "transfer" here is always a projection, never a state
// change. Read-only by construction.
//
// No DB, no React, no "use server": imported by both server pages and client
// components.

import type { PickPoolEntry, Position, SquadEntry } from "./types";

// Captaining doubles a player's points; a transfer beyond your free ones costs
// a 4-point hit. Both are league rules, surfaced here only to *project* — the
// user makes any real move in the FPL app.
export const CAPTAIN_MULTIPLIER = 2;
export const TRANSFER_HIT = 4;

// EP is currently only computed at horizon = 1 (see model_player_ep). Anything
// multi-GW is flagged as TODO in the UI rather than faked.
export const PROJECTION_HORIZON = 1;

// ---------- captain projections ----------

// Projected points if this player wears the armband (EP × 2). Null EP → null.
export function projectAsCaptain(ep: number | null | undefined): number | null {
  return ep == null ? null : ep * CAPTAIN_MULTIPLIER;
}

export interface CaptainProjection {
  entry: SquadEntry;
  projected: number | null; // EP × 2
  // Delta of this pick's projected haul vs the user's *current* captain.
  vsCurrent: number | null;
  // Delta vs the model's recommended (top-EP) captain. 0 when this IS the pick.
  vsRecommended: number | null;
  isRecommended: boolean;
  isCurrent: boolean;
}

// Build a captain projection for one squad member against the current + the
// recommended captain. All read-only.
export function captainProjection(
  entry: SquadEntry,
  current: SquadEntry | null,
  recommended: SquadEntry | null,
): CaptainProjection {
  const projected = projectAsCaptain(entry.expected_points);
  const currentProj = projectAsCaptain(current?.expected_points);
  const recProj = projectAsCaptain(recommended?.expected_points);
  return {
    entry,
    projected,
    vsCurrent:
      projected != null && currentProj != null ? projected - currentProj : null,
    vsRecommended:
      projected != null && recProj != null ? projected - recProj : null,
    isRecommended:
      recommended?.player.fpl_id === entry.player.fpl_id && recommended != null,
    isCurrent: entry.is_captain,
  };
}

// The user's top captain candidates (starters, highest EP first). Used by the
// "Compare captains" mini-comparison — #1 is the model's pick.
export function captainCandidates(
  entries: SquadEntry[],
  limit = 3,
): SquadEntry[] {
  return entries
    .filter((e) => !e.on_bench && e.expected_points != null)
    .slice()
    .sort(
      (a, b) => (b.expected_points ?? -Infinity) - (a.expected_points ?? -Infinity),
    )
    .slice(0, limit);
}

// The squad member the user currently has as captain (from the read-only
// user_squad mirror), if any.
export function currentCaptain(entries: SquadEntry[]): SquadEntry | null {
  return entries.find((e) => e.is_captain) ?? null;
}

// ---------- transfer projections (simulate out → in) ----------

export interface TransferProjection {
  out: SquadEntry;
  in: PickPoolEntry;
  // Projected one-GW EP swing (in − out). Positive = an upgrade.
  epSwing: number | null;
  // Price difference in tenths of a million (in − out). Positive = costs more.
  costDelta: number;
  // Net if the move uses a free transfer (no hit) vs. costs a −4 hit.
  netFree: number | null;
  netHit: number | null;
}

// The best like-for-like replacement for `target` from the pool: same position,
// not already owned, highest projected EP. Returns null when nothing qualifies.
// Pure projection — simulates the swing, persists nothing.
export function simulateTransferOut(
  target: SquadEntry,
  pool: PickPoolEntry[],
  ownedPlayerIds: Iterable<number>,
): TransferProjection | null {
  const owned = new Set(ownedPlayerIds);
  const pos = target.player.position;

  let best: PickPoolEntry | null = null;
  for (const e of pool) {
    if (e.player.position !== pos) continue;
    if (owned.has(e.player.fpl_id)) continue;
    if (e.player.fpl_id === target.player.fpl_id) continue;
    if (e.expected_points == null) continue;
    if (
      best == null ||
      (e.expected_points ?? -Infinity) > (best.expected_points ?? -Infinity)
    ) {
      best = e;
    }
  }
  if (!best) return null;

  return buildTransferProjection(target, best);
}

// Assemble the swing/cost/net figures for a specific out → in pair.
export function buildTransferProjection(
  out: SquadEntry,
  incoming: PickPoolEntry,
): TransferProjection {
  const outEp = out.expected_points;
  const inEp = incoming.expected_points;
  const epSwing = outEp != null && inEp != null ? inEp - outEp : null;
  return {
    out,
    in: incoming,
    epSwing,
    costDelta: incoming.player.price - out.player.price,
    netFree: epSwing,
    netHit: epSwing != null ? epSwing - TRANSFER_HIT : null,
  };
}

// Across the whole squad, the single most valuable like-for-like transfer by
// projected swing. Powers the dashboard "Best transfer" card. Read-only.
export function bestSquadTransfer(
  entries: SquadEntry[],
  pool: PickPoolEntry[],
): TransferProjection | null {
  const ownedIds = entries.map((e) => e.player.fpl_id);
  let best: TransferProjection | null = null;
  for (const entry of entries) {
    const sim = simulateTransferOut(entry, pool, ownedIds);
    if (!sim || sim.epSwing == null) continue;
    if (best == null || (best.epSwing ?? -Infinity) < sim.epSwing) best = sim;
  }
  return best;
}

// ---------- squad summary ----------

export interface SquadSummary {
  value: number; // total price, tenths of a million
  count: number;
  byPosition: Record<Position, number>;
}

export function squadSummary(entries: SquadEntry[]): SquadSummary {
  const byPosition: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  let value = 0;
  for (const e of entries) {
    value += e.player.price;
    byPosition[e.player.position] += 1;
  }
  return { value, count: entries.length, byPosition };
}
