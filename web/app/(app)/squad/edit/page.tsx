import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { getCurrentGw } from "@/lib/gameweek";
import { getCurrentUser, getPlayerPool, getSquadSelections } from "@/lib/queries";
import { EmptyState, PageHeader } from "@/components/ui";
import SquadEditor from "@/components/SquadEditor";
import type { SquadSelection } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SquadEditPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;
  const user = await getCurrentUser(userId);
  if (!user) redirect("/login");

  const currentGw = await getCurrentGw();
  const gw = currentGw?.gw ?? null;

  // Reference/model data (open) + this user's existing squad (scoped).
  const [pool, existing] = await Promise.all([
    getPlayerPool(gw),
    getSquadSelections(userId, gw),
  ]);

  const initialSelections: SquadSelection[] = existing.map((r) => ({
    playerId: r.player_id,
    onBench: r.on_bench,
    isCaptain: r.is_captain,
    isVice: r.is_vice,
  }));

  return (
    <div>
      <PageHeader
        title="Pick your squad"
        subtitle={
          gw != null
            ? `Gameweek ${gw} · build your 15-man squad`
            : "Build your 15-man squad"
        }
      />

      {gw == null || pool.length === 0 ? (
        <>
          <EmptyState
            title="Player data isn't ready yet"
            hint="The player pool and projections appear once the pipeline has loaded this season's players, teams and fixtures."
          />
          <div className="mt-4">
            <Link href="/" className="text-sm font-medium text-accent hover:underline">
              ← Back to dashboard
            </Link>
          </div>
        </>
      ) : (
        <SquadEditor gw={gw} pool={pool} initialSelections={initialSelections} />
      )}
    </div>
  );
}
