import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { getCurrentGw } from "@/lib/gameweek";
import {
  getCurrentUser,
  getPlayerPool,
  getSquadSelections,
} from "@/lib/queries";
import { EmptyState, PageHeader } from "@/components/ui";
import { PitchPlanner } from "@/components/fpl/PitchPlanner";
import {
  DEFAULT_FORMATION,
  formationFromCounts,
  type Formation,
} from "@/lib/pitch";
import type { Position, SquadSelection } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SquadPlannerPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;
  const user = await getCurrentUser(userId);
  if (!user) redirect("/login");

  const currentGw = await getCurrentGw();
  const gw = currentGw?.gw ?? null;

  // Reference/model pool (open) + this user's existing plan (scoped).
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

  // Infer the saved formation from the stored starters (falls back to default).
  const posById = new Map<number, Position>(
    pool.map((e) => [e.player.fpl_id, e.player.position]),
  );
  const starterCounts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const s of existing) {
    if (s.on_bench) continue;
    const pos = posById.get(s.player_id);
    if (pos) starterCounts[pos] += 1;
  }
  const initialFormation: Formation =
    formationFromCounts(starterCounts) ?? DEFAULT_FORMATION;

  return (
    <div>
      <PageHeader
        title="Plan squad"
        subtitle={
          gw != null
            ? `Gameweek ${gw} · a what-if planner — nothing here writes to FPL`
            : "Plan your 15-man squad"
        }
      />

      {gw == null || pool.length === 0 ? (
        <>
          <EmptyState
            title="Player data isn't ready yet"
            hint="The player pool and projections appear once the pipeline has loaded this season's players, teams and fixtures."
          />
          <div className="mt-4">
            <Link
              href="/"
              className="text-sm font-medium text-accent hover:underline"
            >
              ← Back to dashboard
            </Link>
          </div>
        </>
      ) : (
        <PitchPlanner
          gw={gw}
          pool={pool}
          initialSelections={initialSelections}
          initialFormation={initialFormation}
        />
      )}
    </div>
  );
}
