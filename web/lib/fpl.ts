import "server-only";

// Server-only read layer for the public (unauthenticated) FPL API.
//
// Mirrors pipeline/fpl_api.py: browser-like User-Agent, GET-only, and resilient
// (returns null on any failure instead of throwing) so a slow or unreachable
// FPL API degrades to an empty UI rather than a 500. These are READS — we never
// write to FPL. The browser never calls this; it runs in server components and
// server actions only, and DATABASE_URL / sessions are never involved here.

const BASE = "https://fantasy.premierleague.com/api";

// The FPL API rejects some default client User-Agents; send a browser-like one
// (same posture as the Python pipeline).
const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

// Cache FPL responses across requests. Season history changes at most once per
// gameweek; picks change once per GW after the deadline — an hour is plenty and
// keeps the profile page snappy without hammering FPL.
const REVALIDATE_SECONDS = 3600;

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: HEADERS,
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) return null; // 404 (picks pre-deadline) or any other non-2xx
    return (await res.json()) as T;
  } catch {
    return null; // network error, timeout, invalid JSON — degrade gracefully
  }
}

// ---- FPL response shapes (only the fields we use) ----

export interface FplEntryPastSeason {
  season_name: string; // e.g. "2023/24"
  total_points: number;
  rank: number; // final overall rank that season
}

export interface FplEntryCurrentEvent {
  event: number; // gameweek number
  points: number;
  total_points: number;
  rank: number | null;
  overall_rank: number | null;
}

export interface FplEntryHistory {
  current: FplEntryCurrentEvent[];
  past: FplEntryPastSeason[];
  chips: unknown[];
}

export interface FplPick {
  element: number;
  position: number; // 1..15 (12..15 = bench)
  is_captain: boolean;
  is_vice_captain: boolean;
}

export interface FplEntryPicks {
  picks: FplPick[];
}

// chips[], current[], past[] for an entry (season history lives here).
export async function getEntryHistory(
  entryId: number,
): Promise<FplEntryHistory | null> {
  return getJson<FplEntryHistory>(`/entry/${entryId}/history/`);
}

// Picks for an entry in a given GW. Only available AFTER that GW's deadline;
// the API returns 404 before then, which getJson turns into null.
export async function getEntryPicks(
  entryId: number,
  gw: number,
): Promise<FplEntryPicks | null> {
  return getJson<FplEntryPicks>(`/entry/${entryId}/event/${gw}/picks/`);
}
