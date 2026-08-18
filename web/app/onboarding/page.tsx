import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getCurrentUser } from "@/lib/queries";
import FplIdOnboard from "@/components/FplIdOnboard";

// First-login onboarding. Lives OUTSIDE the (app) group on purpose, so it gets
// its own minimal chrome — a top bar with just the wordmark, no nav — instead
// of the full AppShell. Middleware already requires a session here.
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const user = await getCurrentUser(session.user.id);
  if (!user) redirect("/login");

  // Already linked — nothing to do here.
  if (user.fpl_entry_id != null) redirect("/");

  return (
    <div className="relative flex min-h-[100dvh] flex-col">
      {/* Wordmark-only top bar */}
      <header className="flex h-14 items-center gap-2 px-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo/mark.svg" alt="" className="h-8 w-auto" />
        <span className="text-sm font-extrabold tracking-tight text-primary">
          AI Gaffer
        </span>
      </header>

      <div
        className="glow-pitch pointer-events-none absolute inset-x-0 top-0 h-72"
        aria-hidden
      />

      <main className="relative flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-md">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-extrabold tracking-tight text-primary">
              Welcome
            </h1>
            <p className="mt-1.5 text-sm text-secondary">
              One quick step to get you set up.
            </p>
          </div>

          <FplIdOnboard showSkip redirectTo="/" />
        </div>
      </main>
    </div>
  );
}
