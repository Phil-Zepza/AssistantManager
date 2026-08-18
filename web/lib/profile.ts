import "server-only";

import { getEntryHistory } from "./fpl";
import type {
  LmsPick,
  LmsRoundEntry,
  LmsStatus,
  LmsSummary,
  SeasonHistoryRow,
  Team,
} from "./types";

// Season label for a given calendar month/year. The Premier League season runs
// Aug–May, so from July onward we're in the `year/(year+1)` season.
function seasonLabelFor(date: Date): string {
  const y = date.getFullYear();
  const startYear = date.getMonth() >= 6 ? y : y - 1; // month is 0-based
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function currentSeasonLabel(now: Date = new Date()): string {
  return seasonLabelFor(now);
}

// The FPL mini-league tag shown on the profile header (e.g. "PUSB26"): the
// league code + the 2-digit season start year. This is the real mini-league
// name ("PUSB"), independent of the app's own brand (now "AI Gaffer").
export const LEAGUE_WORDMARK = "PUSB";

export function teamTag(now: Date = new Date()): string {
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return `${LEAGUE_WORDMARK}${String(startYear % 100).padStart(2, "0")}`;
}

// Build the season-history rows for the profile from the FPL entry history.
// Past seasons come straight from `past[]`; the in-progress season is derived
// from the latest event in `current[]` (its running overall rank + total). A
// null fpl_entry_id, an unreachable API, or an entry with no history all yield
// an empty array so the card can show its empty state.
export async function getSeasonHistory(
  fplEntryId: number | null,
): Promise<SeasonHistoryRow[]> {
  if (fplEntryId == null) return [];

  const history = await getEntryHistory(fplEntryId);
  if (!history) return [];

  const past: SeasonHistoryRow[] = (history.past ?? []).map((p) => ({
    season: p.season_name,
    overallRank: p.rank ?? null,
    points: p.total_points ?? null,
    isCurrent: false,
  }));

  // Latest gameweek row = the current season's running standing.
  const current = history.current ?? [];
  let currentRow: SeasonHistoryRow | null = null;
  if (current.length > 0) {
    const latest = current.reduce((a, b) => (b.event > a.event ? b : a));
    currentRow = {
      season: currentSeasonLabel(),
      overallRank: latest.overall_rank ?? null,
      points: latest.total_points ?? null,
      isCurrent: true,
    };
  }

  // Newest first: current season on top, then past seasons most-recent-first.
  const rows = [...past].reverse();
  return currentRow ? [currentRow, ...rows] : rows;
}

// Derive an LMS entry's survival status under the strict "draw = OUT" rule.
// Prefer the explicit `survived` flag when the pipeline has set it; otherwise
// fall back to the raw result string.
function statusFromPick(pick: LmsPick): LmsStatus {
  if (pick.survived === true) return "alive";
  if (pick.survived === false) return "out";
  const r = (pick.result ?? "").toLowerCase();
  if (r === "win") return "alive";
  if (r === "draw" || r === "loss" || r === "lose") return "out";
  return "pending";
}

// Summarise a user's LMS picks for the profile card: entry count, per-round
// alive/out status, and whether they're still in it (any round out = knocked
// out). `teams` maps team_id -> Team for showing the backed team's short name.
export function summariseLms(
  picks: LmsPick[],
  teams: Map<number, Team>,
): LmsSummary {
  const rounds: LmsRoundEntry[] = picks.map((p) => ({
    round_gw: p.round_gw,
    teamShort: p.team_id != null ? (teams.get(p.team_id)?.short_name ?? null) : null,
    result: p.result,
    status: statusFromPick(p),
  }));

  const alive = rounds.length > 0 && rounds.every((r) => r.status !== "out");

  return { entries: rounds.length, alive, rounds };
}
