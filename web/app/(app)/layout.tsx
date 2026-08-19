import { auth } from "@/auth";
import { getCurrentGw, getNextLmsDeadline } from "@/lib/gameweek";
import { AppShell } from "@/components/shell/AppShell";

// Layout for the authenticated app. Middleware already gates these routes; here
// we resolve the session (for the avatar) and the real current GW + deadline
// (wired from lib/gameweek) for the top bar. Individual pages still enforce
// auth + redirect, so we don't redirect here.
//
// The deadline shown in the app bar uses getNextLmsDeadline() (day before first
// fixture kickoff) rather than gameweeks.deadline (the FPL transfer deadline) so
// the app-bar countdown matches the competition-screen status header, which also
// derives from computeDefaultDeadline / setRoundDeadline override.
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [session, gw, lmsDeadline] = await Promise.all([
    auth(),
    getCurrentGw(),
    getNextLmsDeadline(),
  ]);

  return (
    <AppShell
      userEmail={session?.user?.email ?? null}
      gw={gw?.gw ?? null}
      deadline={lmsDeadline ?? gw?.deadline ?? null}
    >
      {children}
    </AppShell>
  );
}
