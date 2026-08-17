import { auth } from "@/auth";
import { getCurrentGw } from "@/lib/gameweek";
import { AppShell } from "@/components/shell/AppShell";

// Layout for the authenticated app. Middleware already gates these routes; here
// we resolve the session (for the avatar) and the real current GW + deadline
// (wired from lib/gameweek) for the top bar. Individual pages still enforce
// auth + redirect, so we don't redirect here.
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [session, gw] = await Promise.all([auth(), getCurrentGw()]);

  return (
    <AppShell
      userEmail={session?.user?.email ?? null}
      gw={gw?.gw ?? null}
      deadline={gw?.deadline ?? null}
    >
      {children}
    </AppShell>
  );
}
