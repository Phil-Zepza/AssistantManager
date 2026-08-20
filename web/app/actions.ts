"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { auth, signIn, signOut } from "@/auth";
import { q, tx } from "@/lib/db";
import { getCurrentGw } from "@/lib/gameweek";
import { getEntryPicks } from "@/lib/fpl";
import { ONBOARDING_SKIP_COOKIE } from "@/lib/onboarding";
import { validateSquad, type SquadMember } from "@/lib/squad";
import type {
  LmsEntryStatus,
  LmsSpreadMode,
  LmsSpreadSource,
  Position,
  SquadSelection,
} from "@/lib/types";
import { autoSoftApplies, roundSkipStatus } from "@/lib/lmsPlanner";
import { getCompetitionSkip } from "@/lib/queries";

// Send a magic-link email via the Resend provider. Returns a status object so
// the login page can show "check your email" without a full-page redirect.
export async function sendMagicLink(
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = email.trim();
  if (!trimmed) return { ok: false, error: "Enter your email address." };

  try {
    await signIn("resend", { email: trimmed, redirect: false, redirectTo: "/" });
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Could not send the magic link. Please try again.",
    };
  }
}

// Save the FPL entry id (first-login onboarding). The user id is taken from the
// server session — client input is never trusted for scoping.
export async function saveFplEntryId(fplEntryId: number): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  await q(`update users set fpl_entry_id = $1 where id = $2`, [
    fplEntryId,
    userId,
  ]);
  revalidatePath("/");
}

// Re-import a user's squad by mirroring their FPL picks into `user_squad`. This
// is a READ against the public FPL API (GET picks) — we never write to FPL. It
// mirrors the pipeline's `_sync_user_squad`: it ONLY overwrites when the picks
// endpoint actually returns data (picks 404 before a GW deadline), so a
// manually-entered squad is never wiped when FPL has nothing to give yet.
// Returns the number of rows imported (0 = nothing available yet, unchanged).
async function reimportSquadFromFpl(
  userId: number,
  fplEntryId: number,
): Promise<number> {
  const gw = await getCurrentGw();
  if (!gw) return 0;

  const data = await getEntryPicks(fplEntryId, gw.gw);
  if (!data || !Array.isArray(data.picks) || data.picks.length === 0) {
    return 0; // 404 pre-deadline / no data — leave any existing squad untouched
  }

  const rows = data.picks.map((p) => ({
    player_id: p.element,
    is_captain: !!p.is_captain,
    is_vice: !!p.is_vice_captain,
    on_bench: (p.position ?? 0) > 11,
  }));

  await tx(async (client) => {
    await client.query(`delete from user_squad where user_id = $1 and gw = $2`, [
      userId,
      gw.gw,
    ]);
    for (const r of rows) {
      await client.query(
        `insert into user_squad (user_id, gw, player_id, is_captain, is_vice, on_bench)
           values ($1, $2, $3, $4, $5, $6)`,
        [userId, gw.gw, r.player_id, r.is_captain, r.is_vice, r.on_bench],
      );
    }
  });

  return rows.length;
}

// Save the profile edit (display name + FPL team ID) from the Profile canvas.
// Scoped to the session user id. When the FPL team ID changes to a new value we
// trigger a squad re-import (a READ from FPL — see above), so the mirrored squad
// follows the newly linked team. The re-import is best-effort: a failed/empty
// FPL read never fails the save.
export async function saveProfile(input: {
  displayName: string | null;
  fplEntryId: number | null;
}): Promise<{ ok: boolean; reimported: boolean; importedCount: number }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const prev = await q<{ fpl_entry_id: number | null }>(
    `select fpl_entry_id from users where id = $1`,
    [userId],
  );
  const prevFplId = prev[0]?.fpl_entry_id ?? null;

  await q(`update users set display_name = $1, fpl_entry_id = $2 where id = $3`, [
    input.displayName,
    input.fplEntryId,
    userId,
  ]);

  let reimported = false;
  let importedCount = 0;
  const changed =
    input.fplEntryId != null && input.fplEntryId !== prevFplId;
  if (changed) {
    try {
      importedCount = await reimportSquadFromFpl(userId, input.fplEntryId!);
      reimported = importedCount > 0;
    } catch {
      // Non-fatal: the profile still saves; the squad simply isn't refreshed.
      reimported = false;
    }
  }

  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: true, reimported, importedCount };
}

// "Do this later" on the onboarding screen: remember the choice (cookie) and
// send the user into the app. No DB write — they can link their team any time
// from the profile.
export async function skipOnboarding(): Promise<void> {
  const store = await cookies();
  store.set(ONBOARDING_SKIP_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect("/");
}

// Save a manually-picked 15-man squad for the given gameweek. The user id comes
// from the server session — client input is never trusted for scoping. Prices,
// positions and clubs are re-read from the DB (the client only sends player ids
// + roles), the squad is re-validated server-side, then prior rows for this
// (user, gw) are replaced atomically. Redirects to the dashboard on success.
export async function saveSquad(input: {
  gw: number;
  selections: SquadSelection[];
}): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const gw = Number(input.gw);
  if (!Number.isInteger(gw) || gw <= 0) {
    throw new Error("Invalid gameweek.");
  }

  const selections = input.selections ?? [];
  const ids = selections.map((s) => Number(s.playerId));
  if (ids.length !== new Set(ids).size) {
    throw new Error("Duplicate players in squad.");
  }

  // Re-read authoritative position/club/price from the DB — do NOT trust the
  // client for anything but which players and their roles.
  const rows = await q<{ fpl_id: number; position: Position; team_id: number | null }>(
    `select fpl_id, position, team_id from players where fpl_id = any($1::int[])`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.fpl_id, r]));
  if (byId.size !== ids.length) {
    throw new Error("One or more selected players no longer exist.");
  }

  const members: SquadMember[] = selections.map((s) => {
    const p = byId.get(Number(s.playerId))!;
    return {
      playerId: p.fpl_id,
      position: p.position,
      teamId: p.team_id,
      onBench: !!s.onBench,
      isCaptain: !!s.isCaptain,
      isVice: !!s.isVice,
    };
  });

  const errors = validateSquad(members);
  if (errors.length > 0) {
    throw new Error(`Invalid squad: ${errors[0]}`);
  }

  // Replace prior rows for this (user, gw) atomically.
  await tx(async (client) => {
    await client.query(
      `delete from user_squad where user_id = $1 and gw = $2`,
      [userId, gw],
    );
    for (const m of members) {
      await client.query(
        `insert into user_squad (user_id, gw, player_id, is_captain, is_vice, on_bench)
           values ($1, $2, $3, $4, $5, $6)`,
        [userId, gw, m.playerId, m.isCaptain, m.isVice, m.onBench],
      );
    }
  });

  revalidatePath("/");
  redirect("/");
}

// Record + lock an LMS pick for a round. This is the app's one legitimate
// domain write (we own the LMS game). The user id comes from the server session
// — client input is never trusted for scoping. Rules enforced here:
//  - the round must be a real, LMS-eligible (7+ fixtures), unfinished GW;
//  - the backed team must have a fixture in that round and not already be spent
//    by this user in an earlier round (single-use per season);
//  - a pick is single-use per round: once recorded it can't be changed (draw =
//    OUT, so locking matters), enforced by the (user_id, round_gw) primary key.
export async function saveLmsPick(input: {
  roundGw: number;
  teamId: number;
}): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const roundGw = Number(input.roundGw);
  const teamId = Number(input.teamId);
  if (!Number.isInteger(roundGw) || roundGw <= 0) {
    return { ok: false, error: "Invalid round." };
  }
  if (!Number.isInteger(teamId) || teamId <= 0) {
    return { ok: false, error: "Invalid team." };
  }

  // Round must exist and be LMS-eligible + not finished.
  const gwRows = await q<{ lms_eligible: boolean; finished: boolean }>(
    `select lms_eligible, finished from gameweeks where gw = $1`,
    [roundGw],
  );
  if (gwRows.length === 0) return { ok: false, error: "Unknown round." };
  if (!gwRows[0].lms_eligible) {
    return { ok: false, error: "Round has fewer than 7 fixtures." };
  }
  if (gwRows[0].finished) {
    return { ok: false, error: "That round is already finished." };
  }

  // The backed team must actually play in this round.
  const playsRows = await q<{ n: string }>(
    `select count(*)::text as n from fixtures
       where gw = $1 and (home_team = $2 or away_team = $2)`,
    [roundGw, teamId],
  );
  if (!playsRows[0] || Number(playsRows[0].n) === 0) {
    return { ok: false, error: "That team has no fixture this round." };
  }

  // Single-use per season: reject a team already spent in an earlier round.
  const usedRows = await q<{ round_gw: number }>(
    `select round_gw from lms_picks where user_id = $1 and team_id = $2`,
    [userId, teamId],
  );
  const usedElsewhere = usedRows.some((r) => r.round_gw !== roundGw);
  if (usedElsewhere) {
    return { ok: false, error: "That team is already used this season." };
  }

  // Locked: a pick for this round can't be changed once recorded.
  const existing = await q<{ team_id: number | null }>(
    `select team_id from lms_picks where user_id = $1 and round_gw = $2`,
    [userId, roundGw],
  );
  if (existing.length > 0) {
    return { ok: false, error: "This round's pick is already locked." };
  }

  await q(
    `insert into lms_picks (user_id, round_gw, team_id, result, survived)
       values ($1, $2, $3, 'pending', null)`,
    [userId, roundGw, teamId],
  );
  revalidatePath("/lms");
  return { ok: true };
}

// ================= LMS rework: Competitions -> Entries =================
// All writes here go to OUR Postgres only (we own the LMS game). userId ALWAYS
// comes from the server session; every write verifies the target competition/
// entry is owned by that user before mutating. submitPick is the single lock
// write — forward-plan overrides are pure client-side recompute (planner pins),
// never persisted, so the pipeline auto-resolve step can never mistake a plan
// preference for a locked submission.

const RESERVE_STRATEGIES = ["safest", "manual", "smart"] as const;
function isReserveStrategy(
  s: unknown,
): s is (typeof RESERVE_STRATEGIES)[number] {
  return (
    typeof s === "string" &&
    (RESERVE_STRATEGIES as readonly string[]).includes(s)
  );
}

const SPREAD_MODES = ["off", "soft", "strong"] as const;
function isSpreadMode(s: unknown): s is LmsSpreadMode {
  return typeof s === "string" && (SPREAD_MODES as readonly string[]).includes(s);
}

const SPREAD_SOURCES = ["spread", "matched"] as const;
// Accepts 'spread' | 'matched' | null | undefined (the last two -> null).
function normalizeSpreadSource(s: unknown): LmsSpreadSource {
  return typeof s === "string" && (SPREAD_SOURCES as readonly string[]).includes(s)
    ? (s as LmsSpreadSource)
    : null;
}

// Ownership guard: load an entry only if its competition belongs to userId.
async function loadOwnedEntry(
  userId: number,
  entryId: number,
): Promise<{ id: number; competition_id: number; status: LmsEntryStatus } | null> {
  const rows = await q<{
    id: number;
    competition_id: number;
    status: LmsEntryStatus;
  }>(
    `select e.id, e.competition_id, e.status
       from lms_entries e
       join lms_competitions c on c.id = e.competition_id
      where e.id = $1 and c.user_id = $2`,
    [entryId, userId],
  );
  return rows[0] ?? null;
}

async function competitionOwned(
  userId: number,
  competitionId: number,
): Promise<boolean> {
  const rows = await q<{ id: number }>(
    `select id from lms_competitions where id = $1 and user_id = $2`,
    [competitionId, userId],
  );
  return rows.length > 0;
}

// Create a competition with one or more entries. Optional per-entry backfillPicks
// record rounds the user already played before joining (is_backfill=true, result
// 'pending' — the pipeline auto-resolve settles them once their fixtures finish).
export async function createCompetition(input: {
  name: string;
  startGw: number;
  entries: { label: string; backfillPicks?: { gw: number; teamId: number }[] }[];
}): Promise<{ ok: boolean; error?: string; competitionId?: number }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "Enter a competition name." };

  const startGw = Number(input.startGw);
  if (!Number.isInteger(startGw) || startGw <= 0) {
    return { ok: false, error: "Invalid start gameweek." };
  }

  const entries = input.entries ?? [];
  if (entries.length === 0) {
    return { ok: false, error: "Add at least one entry." };
  }

  // Validate entries + backfill picks up front (fail before writing anything).
  const cleanEntries: { label: string; picks: { gw: number; teamId: number }[] }[] =
    [];
  const allTeamIds = new Set<number>();
  for (const e of entries) {
    const label = (e.label ?? "").trim();
    if (!label) return { ok: false, error: "Every entry needs a label." };

    const picks = e.backfillPicks ?? [];
    const seenGw = new Set<number>();
    const seenTeam = new Set<number>();
    const clean: { gw: number; teamId: number }[] = [];
    for (const p of picks) {
      const gw = Number(p.gw);
      const teamId = Number(p.teamId);
      if (!Number.isInteger(gw) || gw <= 0 || !Number.isInteger(teamId) || teamId <= 0) {
        return { ok: false, error: "Invalid backfill pick." };
      }
      if (seenGw.has(gw)) {
        return { ok: false, error: `Two picks for GW${gw} in "${label}".` };
      }
      if (seenTeam.has(teamId)) {
        return { ok: false, error: `Team used twice in "${label}".` };
      }
      seenGw.add(gw);
      seenTeam.add(teamId);
      allTeamIds.add(teamId);
      clean.push({ gw, teamId });
    }
    cleanEntries.push({ label, picks: clean });
  }

  // Every backfilled team must exist (FK would otherwise abort the tx).
  if (allTeamIds.size > 0) {
    const existing = await q<{ fpl_id: number }>(
      `select fpl_id from teams where fpl_id = any($1::int[])`,
      [[...allTeamIds]],
    );
    if (existing.length !== allTeamIds.size) {
      return { ok: false, error: "One or more backfill teams are unknown." };
    }
  }

  let competitionId = 0;
  await tx(async (client) => {
    const compRes = await client.query(
      `insert into lms_competitions (user_id, name, start_gw)
         values ($1, $2, $3) returning id`,
      [userId, name, startGw],
    );
    competitionId = compRes.rows[0].id as number;

    for (const e of cleanEntries) {
      const entryRes = await client.query(
        `insert into lms_entries (competition_id, label) values ($1, $2) returning id`,
        [competitionId, e.label],
      );
      const entryId = entryRes.rows[0].id as number;
      for (const p of e.picks) {
        await client.query(
          `insert into lms_entry_picks (entry_id, gw, team_id, result, is_backfill)
             values ($1, $2, $3, 'pending', true)`,
          [entryId, p.gw, p.teamId],
        );
      }
    }
  });

  revalidatePath("/lms");
  return { ok: true, competitionId };
}

// Add a further independent entry to an existing (owned) competition.
export async function addEntry(
  competitionId: number,
  label: string,
  strategy?: string,
): Promise<{ ok: boolean; error?: string; entryId?: number }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const compId = Number(competitionId);
  if (!Number.isInteger(compId) || compId <= 0) {
    return { ok: false, error: "Invalid competition." };
  }
  const cleanLabel = (label ?? "").trim();
  if (!cleanLabel) return { ok: false, error: "Enter an entry label." };
  const mode = strategy == null ? "smart" : strategy;
  if (!isReserveStrategy(mode)) {
    return { ok: false, error: "Invalid reserve strategy." };
  }
  if (!(await competitionOwned(userId, compId))) {
    return { ok: false, error: "Competition not found." };
  }

  let entryId = 0;
  await tx(async (client) => {
    const res = await client.query(
      `insert into lms_entries (competition_id, label, reserve_strategy)
         values ($1, $2, $3) returning id`,
      [compId, cleanLabel, mode],
    );
    entryId = res.rows[0].id as number;

    // Auto-Soft on the 2nd entry: when adding an entry takes a competition from
    // 1 -> 2 entries and its spread_mode is still 'off', default it to 'soft'.
    // Decision lives in the pure, unit-tested autoSoftApplies(); it never lowers an
    // explicit 'soft'/'strong' choice and fires only at exactly 2 entries (so a re-run
    // at 3+ is a no-op). Read count + mode in the same tx as the insert for consistency.
    const stateRows = await client.query(
      `select (select count(*) from lms_entries e where e.competition_id = $1)::int as n,
              (select spread_mode from lms_competitions where id = $1) as mode`,
      [compId],
    );
    const n = Number(stateRows.rows[0].n);
    const currentMode = stateRows.rows[0].mode as LmsSpreadMode;
    if (autoSoftApplies(n, currentMode)) {
      await client.query(
        `update lms_competitions set spread_mode = 'soft' where id = $1`,
        [compId],
      );
    }
  });

  revalidatePath("/lms");
  return { ok: true, entryId };
}

// Record + lock the current round's pick for an entry. THE single lock write.
// Mirrors saveLmsPick's rules, scoped per entry: the round must be a real,
// LMS-eligible, unfinished GW; the team must play that round; single-use per
// entry (enforced by unique(entry_id, team_id)); one pick per round (unique
// (entry_id, gw)). Never touches FPL.
export async function submitPick(
  entryId: number,
  gw: number,
  teamId: number,
  spreadSource?: LmsSpreadSource,
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const eId = Number(entryId);
  const roundGw = Number(gw);
  const team = Number(teamId);
  // Provenance from the recomputed plan (PR D). Anything unrecognised -> null.
  const source = normalizeSpreadSource(spreadSource);
  if (!Number.isInteger(eId) || eId <= 0) return { ok: false, error: "Invalid entry." };
  if (!Number.isInteger(roundGw) || roundGw <= 0) {
    return { ok: false, error: "Invalid round." };
  }
  if (!Number.isInteger(team) || team <= 0) return { ok: false, error: "Invalid team." };

  const entry = await loadOwnedEntry(userId, eId);
  if (!entry) return { ok: false, error: "Entry not found." };
  if (entry.status === "out") {
    return { ok: false, error: "This entry is already out." };
  }

  // Round must exist, not be finished, and not be skipped FOR THIS COMPETITION.
  // The skip decision uses the same per-competition helper as the planner (auto
  // threshold + manual skips), NOT the global gameweeks.lms_eligible flag — so a
  // competition that turns its threshold off (or manually skips a round) stays
  // consistent between the plan and what submitPick accepts.
  const gwRows = await q<{ num_fixtures: number | null; finished: boolean }>(
    `select num_fixtures, finished from gameweeks where gw = $1`,
    [roundGw],
  );
  if (gwRows.length === 0) return { ok: false, error: "Unknown round." };
  if (gwRows[0].finished) {
    return { ok: false, error: "That round is already finished." };
  }
  const skip = roundSkipStatus(
    { gw: roundGw, lmsEligible: true, numFixtures: gwRows[0].num_fixtures },
    await getCompetitionSkip(entry.competition_id),
  );
  if (skip.skipped) {
    return {
      ok: false,
      error:
        skip.kind === "manual"
          ? "That round is skipped for this competition."
          : "Round has too few fixtures to count for this competition.",
    };
  }

  // The backed team must play in this round.
  const playsRows = await q<{ n: string }>(
    `select count(*)::text as n from fixtures
       where gw = $1 and (home_team = $2 or away_team = $2)`,
    [roundGw, team],
  );
  if (!playsRows[0] || Number(playsRows[0].n) === 0) {
    return { ok: false, error: "That team has no fixture this round." };
  }

  // Single-use per entry: reject a team already spent by this entry.
  const usedRows = await q<{ gw: number }>(
    `select gw from lms_entry_picks where entry_id = $1 and team_id = $2`,
    [eId, team],
  );
  if (usedRows.length > 0) {
    return { ok: false, error: "That team is already used by this entry." };
  }

  // One pick per round: reject if this round is already locked for the entry.
  const existing = await q<{ id: number }>(
    `select id from lms_entry_picks where entry_id = $1 and gw = $2`,
    [eId, roundGw],
  );
  if (existing.length > 0) {
    return { ok: false, error: "This round's pick is already locked." };
  }

  await q(
    `insert into lms_entry_picks (entry_id, gw, team_id, result, is_backfill, spread_source)
       values ($1, $2, $3, 'pending', false, $4)`,
    [eId, roundGw, team, source],
  );
  revalidatePath("/lms");
  return { ok: true };
}

// Set an entry's reserve strategy + confidence floor.
export async function setStrategy(
  entryId: number,
  mode: string,
  floor: number,
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const eId = Number(entryId);
  if (!Number.isInteger(eId) || eId <= 0) return { ok: false, error: "Invalid entry." };
  if (!isReserveStrategy(mode)) {
    return { ok: false, error: "Invalid reserve strategy." };
  }
  const f = Number(floor);
  if (!Number.isFinite(f) || f < 0 || f > 1) {
    return { ok: false, error: "Confidence floor must be between 0 and 1." };
  }
  if (!(await loadOwnedEntry(userId, eId))) {
    return { ok: false, error: "Entry not found." };
  }

  await q(
    `update lms_entries set reserve_strategy = $1, confidence_floor = $2 where id = $3`,
    [mode, f, eId],
  );
  revalidatePath("/lms");
  return { ok: true };
}

// Replace an entry's reserve list. Reserves cannot include already-used teams.
export async function setReserves(
  entryId: number,
  teamIds: number[],
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const eId = Number(entryId);
  if (!Number.isInteger(eId) || eId <= 0) return { ok: false, error: "Invalid entry." };
  if (!(await loadOwnedEntry(userId, eId))) {
    return { ok: false, error: "Entry not found." };
  }

  const ids = [...new Set((teamIds ?? []).map((t) => Number(t)))];
  if (ids.some((t) => !Number.isInteger(t) || t <= 0)) {
    return { ok: false, error: "Invalid team in reserves." };
  }

  if (ids.length > 0) {
    // Teams must exist and not already be spent by this entry.
    const [existing, used] = await Promise.all([
      q<{ fpl_id: number }>(
        `select fpl_id from teams where fpl_id = any($1::int[])`,
        [ids],
      ),
      q<{ team_id: number }>(
        `select team_id from lms_entry_picks where entry_id = $1 and team_id = any($2::int[])`,
        [eId, ids],
      ),
    ]);
    if (existing.length !== ids.length) {
      return { ok: false, error: "One or more reserve teams are unknown." };
    }
    if (used.length > 0) {
      return { ok: false, error: "Cannot reserve a team already used by this entry." };
    }
  }

  await tx(async (client) => {
    await client.query(`delete from lms_entry_reserves where entry_id = $1`, [eId]);
    for (const t of ids) {
      await client.query(
        `insert into lms_entry_reserves (entry_id, team_id) values ($1, $2)`,
        [eId, t],
      );
    }
  });
  revalidatePath("/lms");
  return { ok: true };
}

// Set (or clear) a round's deadline override for a competition. Passing null
// stores NULL, which the read layer treats as "use the computed default"
// (day before the round's first kickoff).
export async function setRoundDeadline(
  competitionId: number,
  gw: number,
  deadline: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const compId = Number(competitionId);
  const roundGw = Number(gw);
  if (!Number.isInteger(compId) || compId <= 0) {
    return { ok: false, error: "Invalid competition." };
  }
  if (!Number.isInteger(roundGw) || roundGw <= 0) {
    return { ok: false, error: "Invalid round." };
  }

  let value: string | null = null;
  if (deadline != null) {
    const ts = new Date(deadline);
    if (Number.isNaN(ts.getTime())) {
      return { ok: false, error: "Invalid deadline." };
    }
    value = ts.toISOString();
  }

  if (!(await competitionOwned(userId, compId))) {
    return { ok: false, error: "Competition not found." };
  }

  await q(
    `insert into lms_competition_deadlines (competition_id, gw, deadline)
       values ($1, $2, $3)
       on conflict (competition_id, gw) do update set deadline = excluded.deadline`,
    [compId, roundGw, value],
  );
  revalidatePath("/lms");
  return { ok: true };
}

// Set a competition's cross-entry spread mode ('off' | 'soft' | 'strong'). This
// is the explicit user choice; addEntry's auto-Soft default never overrides it.
export async function setSpreadMode(
  competitionId: number,
  mode: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const compId = Number(competitionId);
  if (!Number.isInteger(compId) || compId <= 0) {
    return { ok: false, error: "Invalid competition." };
  }
  if (!isSpreadMode(mode)) {
    return { ok: false, error: "Invalid spread mode." };
  }
  if (!(await competitionOwned(userId, compId))) {
    return { ok: false, error: "Competition not found." };
  }

  await q(`update lms_competitions set spread_mode = $1 where id = $2`, [
    mode,
    compId,
  ]);
  revalidatePath("/lms");
  return { ok: true };
}

// Set (or clear) a round's force_same override for a competition. forceSame=true
// upserts the override (collapse the round to one team across entries, any mode);
// forceSame=false clears it (delete the row), returning the round to normal
// mode-driven allocation. Nothing about picks is persisted here — PR D recomputes
// the plan live; only submitPick locks a round.
export async function setSpreadOverride(
  competitionId: number,
  gw: number,
  forceSame: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const compId = Number(competitionId);
  const roundGw = Number(gw);
  if (!Number.isInteger(compId) || compId <= 0) {
    return { ok: false, error: "Invalid competition." };
  }
  if (!Number.isInteger(roundGw) || roundGw <= 0) {
    return { ok: false, error: "Invalid round." };
  }
  if (!(await competitionOwned(userId, compId))) {
    return { ok: false, error: "Competition not found." };
  }

  if (forceSame) {
    await q(
      `insert into lms_competition_spread_overrides (competition_id, gw, force_same)
         values ($1, $2, true)
         on conflict (competition_id, gw) do update set force_same = excluded.force_same`,
      [compId, roundGw],
    );
  } else {
    await q(
      `delete from lms_competition_spread_overrides
        where competition_id = $1 and gw = $2`,
      [compId, roundGw],
    );
  }
  revalidatePath("/lms");
  return { ok: true };
}

// Set (or clear) a competition's fixture-count auto-skip threshold. n = the
// minimum PL fixtures a round needs to count; rounds below it are auto-skipped.
// n = null turns the fixture-count rule off (sub-N rounds then count). Our DB
// only; ownership-checked. Recompute is live client-side — nothing about picks is
// persisted here.
export async function setAutoSkipThreshold(
  competitionId: number,
  n: number | null,
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const compId = Number(competitionId);
  if (!Number.isInteger(compId) || compId <= 0) {
    return { ok: false, error: "Invalid competition." };
  }
  let value: number | null = null;
  if (n != null) {
    const t = Number(n);
    if (!Number.isInteger(t) || t < 1) {
      return { ok: false, error: "Threshold must be a positive whole number, or off." };
    }
    value = t;
  }
  if (!(await competitionOwned(userId, compId))) {
    return { ok: false, error: "Competition not found." };
  }

  await q(`update lms_competitions set auto_skip_under_fixtures = $1 where id = $2`, [
    value,
    compId,
  ]);
  revalidatePath("/lms");
  return { ok: true };
}

// Manually skip a round for a competition (any reason, reversible). Upserts one
// row in lms_competition_skipped_rounds; idempotent. reason is optional free text
// surfaced on the forward-plan tile. Our DB only; ownership-checked.
export async function skipRound(
  competitionId: number,
  gw: number,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const compId = Number(competitionId);
  const roundGw = Number(gw);
  if (!Number.isInteger(compId) || compId <= 0) {
    return { ok: false, error: "Invalid competition." };
  }
  if (!Number.isInteger(roundGw) || roundGw <= 0) {
    return { ok: false, error: "Invalid round." };
  }
  const trimmed = reason?.trim();
  const value = trimmed && trimmed.length > 0 ? trimmed : null;
  if (!(await competitionOwned(userId, compId))) {
    return { ok: false, error: "Competition not found." };
  }

  await q(
    `insert into lms_competition_skipped_rounds (competition_id, gw, reason)
       values ($1, $2, $3)
       on conflict (competition_id, gw) do update set reason = excluded.reason`,
    [compId, roundGw, value],
  );
  revalidatePath("/lms");
  return { ok: true };
}

// Reverse a manual skip: delete the round's lms_competition_skipped_rounds row.
// Idempotent (deleting a non-existent skip is a no-op). Our DB only; ownership-checked.
export async function unskipRound(
  competitionId: number,
  gw: number,
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const compId = Number(competitionId);
  const roundGw = Number(gw);
  if (!Number.isInteger(compId) || compId <= 0) {
    return { ok: false, error: "Invalid competition." };
  }
  if (!Number.isInteger(roundGw) || roundGw <= 0) {
    return { ok: false, error: "Invalid round." };
  }
  if (!(await competitionOwned(userId, compId))) {
    return { ok: false, error: "Competition not found." };
  }

  await q(
    `delete from lms_competition_skipped_rounds
      where competition_id = $1 and gw = $2`,
    [compId, roundGw],
  );
  revalidatePath("/lms");
  return { ok: true };
}

// Sign out and return to /login.
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
