import { q } from "./db";
import type { Gameweek } from "./types";
import { computeDefaultDeadline } from "./lmsPlanner";

// Determine the "current" gameweek: the earliest unfinished GW, else the
// latest GW on record, else null (empty DB). Reference data — open to any
// signed-in user.
export async function getCurrentGw(): Promise<Gameweek | null> {
  const unfinished = await q<Gameweek>(
    `select * from gameweeks where finished = false order by gw asc limit 1`,
  );
  if (unfinished.length > 0) return unfinished[0];

  const latest = await q<Gameweek>(
    `select * from gameweeks order by gw desc limit 1`,
  );
  return latest.length > 0 ? latest[0] : null;
}

// The next LMS-eligible gameweek (>= 7 fixtures) that is not finished.
export async function getNextLmsGw(): Promise<Gameweek | null> {
  const rows = await q<Gameweek>(
    `select * from gameweeks
       where lms_eligible = true and finished = false
       order by gw asc limit 1`,
  );
  return rows.length > 0 ? rows[0] : null;
}

// The effective LMS deadline for the next eligible round: one day before the
// round's earliest fixture kickoff (matching the competition-screen countdown).
// Used by the app-bar so both countdowns read from the same source.
export async function getNextLmsDeadline(): Promise<string | null> {
  const lmsGw = await getNextLmsGw();
  if (lmsGw == null) return null;
  const fixtures = await q<{ gw: number; kickoff: string | null }>(
    `select gw, kickoff from fixtures where gw = $1`,
    [lmsGw.gw],
  );
  return computeDefaultDeadline(lmsGw.gw, fixtures);
}
