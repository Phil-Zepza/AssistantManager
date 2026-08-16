"use server";

import { revalidatePath } from "next/cache";
import { auth, signIn, signOut } from "@/auth";
import { q } from "@/lib/db";

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

// Sign out and return to /login.
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
