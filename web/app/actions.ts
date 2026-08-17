"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth, signIn, signOut } from "@/auth";
import { q, tx } from "@/lib/db";
import { validateSquad, type SquadMember } from "@/lib/squad";
import type { Position, SquadSelection } from "@/lib/types";

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

// Save settings (display name + FPL entry id). Scoped to the session user id.
export async function saveSettings(input: {
  displayName: string | null;
  fplEntryId: number | null;
}): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  await q(
    `update users set display_name = $1, fpl_entry_id = $2 where id = $3`,
    [input.displayName, input.fplEntryId, userId],
  );
  revalidatePath("/settings");
  revalidatePath("/");
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

// Sign out and return to /login.
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
