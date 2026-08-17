import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getCurrentGw } from "@/lib/gameweek";
import {
  getCurrentUser,
  getPlayerPool,
  getRecommendations,
  getSquad,
  recommendedCaptain,
} from "@/lib/queries";
import { bestSquadTransfer, squadSummary } from "@/lib/projections";
import { formationFromCounts } from "@/lib/pitch";
import { formatEp, formatPrice } from "@/lib/format";
import FplIdOnboard from "@/components/FplIdOnboard";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { DashboardCaptainCard } from "@/components/fpl/DashboardCaptainCard";
import { DashboardTransferCard } from "@/components/fpl/DashboardTransferCard";
import type { Position, SquadEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;
  const user = await getCurrentUser(userId);
  if (!user) redirect("/login");

  // First-login onboarding.
  if (user.fpl_entry_id == null) {
    return (
      <div>
        <PageHeader title="Welcome" subtitle="One quick step to get started." />
        <FplIdOnboard userId={user.id} />
      </div>
    );
  }

  const currentGw = await getCurrentGw();
  const { gw: squadGw, entries } = await getSquad(userId, currentGw?.gw ?? null);
  const pool = await getPlayerPool(squadGw ?? currentGw?.gw ?? null);

  const captain = recommendedCaptain(entries);
  const transfer = bestSquadTransfer(entries, pool);

  const recs = await getRecommendations(userId);
  const chipRec = recs.find((r) => r.kind === "chip");
  const chipNote =
    (chipRec?.payload?.["note"] as string | undefined) ??
    (chipRec?.payload?.["chip"] as string | undefined) ??
    null;

  const subtitle =
    squadGw != null
      ? `Gameweek ${squadGw}${user.display_name ? ` · ${user.display_name}` : ""}`
      : "No squad loaded yet";

  return (
    <div>
      <PageHeader title="This week" subtitle={subtitle} />

      {entries.length === 0 ? (
        <EmptyState
          title="No squad to plan yet"
          hint="Enter your 15 players in the planner to get a suggested captain, best transfer and chip guidance now — before the FPL API publishes your picks."
          action={
            <Link href="/squad">
              <Button>Plan squad</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-4">
          <YourXiCard entries={entries} />

          {captain && (
            <DashboardCaptainCard
              captain={captain}
              entries={entries}
              rationale={captainRationale(captain, pool)}
            />
          )}

          {transfer && <DashboardTransferCard projection={transfer} />}

          <ChipWatchCard note={chipNote} />
        </div>
      )}
    </div>
  );
}

// ---- (a) Your XI summary ----

function YourXiCard({ entries }: { entries: SquadEntry[] }) {
  const summary = squadSummary(entries);
  const starterCounts: Record<Position, number> = {
    GK: 0,
    DEF: 0,
    MID: 0,
    FWD: 0,
  };
  for (const e of entries) if (!e.on_bench) starterCounts[e.player.position] += 1;
  const formation =
    formationFromCounts(starterCounts) ??
    `${starterCounts.DEF}-${starterCounts.MID}-${starterCounts.FWD}`;

  const meta = `${summary.count} players · ${summary.byPosition.GK} GK · ${summary.byPosition.DEF} DEF · ${summary.byPosition.MID} MID · ${summary.byPosition.FWD} FWD · ${formation}`;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
            Your XI
          </p>
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold tnum text-primary">
              {formatPrice(summary.value)}
            </span>
            <span className="text-xs font-medium text-muted">squad value</span>
          </div>
        </div>
        <Link
          href="/squad"
          className="shrink-0 text-sm font-semibold text-accent hover:underline"
        >
          Plan squad →
        </Link>
      </div>
      <p className="mt-2 text-xs text-secondary tnum">{meta}</p>
    </Card>
  );
}

// One-line captain rationale, honest about the 1-GW horizon.
function captainRationale(
  captain: SquadEntry,
  pool: { player: { fpl_id: number }; next_fixture: { opponent: { short_name: string } | null; is_home: boolean } | null }[],
): string {
  const pe = pool.find((p) => p.player.fpl_id === captain.player.fpl_id);
  const nf = pe?.next_fixture;
  const fixture =
    nf?.opponent?.short_name != null
      ? ` vs ${nf.opponent.short_name} (${nf.is_home ? "H" : "A"})`
      : "";
  return `Highest projected starter in your XI at ${formatEp(
    captain.expected_points,
  )} xPts${fixture}. 1-GW projection.`;
}

// ---- (d) Chip watch ----

function ChipWatchCard({ note }: { note: string | null }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">
          Chip watch
        </p>
        <Badge tone="warning">Hold</Badge>
      </div>
      <p className="mt-1.5 text-sm text-secondary">
        {note ?? "No chip recommended this week — hold your chips."}
      </p>
    </Card>
  );
}
