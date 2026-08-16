import { q } from "./db";
import type { Gameweek } from "./types";

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
