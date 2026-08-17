import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getCurrentGw } from "@/lib/gameweek";
import {
  getBestTransfers,
  getCurrentUser,
  getRecommendations,
  getSquad,
  recommendedCaptain,
} from "@/lib/queries";
import { formatEp, formatPrice } from "@/lib/format";
import FplIdOnboard from "@/components/FplIdOnboard";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  SectionTitle,
} from "@/components/ui";
import type { SquadEntry } from "@/lib/types";

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
        <PageHeader
          title="Welcome"
          subtitle="One quick step to get started."
        />
        <FplIdOnboard userId={user.id} />
      </div>
    );
  }

  const currentGw = await getCurrentGw();
  const { gw: squadGw, entries } = await getSquad(
    userId,
    currentGw?.gw ?? null,
  );

  const captain = recommendedCaptain(entries);
  const ownedIds = entries.map((e) => e.player.fpl_id);
  const transfers = await getBestTransfers(
    squadGw ?? currentGw?.gw ?? null,
    ownedIds,
  );

  const recs = await getRecommendations(userId);
  const chipRec = recs.find((r) => r.kind === "chip");
  const chipNote =
    (chipRec?.payload?.["note"] as string | undefined) ??
    (chipRec?.payload?.["chip"] as string | undefined) ??
    null;

  const starters = entries.filter((e) => !e.on_bench);
  const bench = entries.filter((e) => e.on_bench);

  return (
    <div>
      <PageHeader
        title="Your squad"
        subtitle={
          squadGw != null
            ? `Gameweek ${squadGw}${
                user.display_name ? ` · ${user.display_name}` : ""
              }`
            : "No squad loaded yet"
        }
      />

      {/* Recommended captain */}
      <Card className="mb-4 border-strong">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-secondary">
              Recommended captain
            </p>
            {captain ? (
              <p className="mt-0.5 text-lg font-bold text-accent">
                {captain.player.web_name}{" "}
                <span className="text-sm font-normal text-secondary">
                  {captain.team?.short_name ?? ""}
                </span>
              </p>
            ) : (
              <p className="mt-0.5 text-sm text-secondary">
                No projections available yet.
              </p>
            )}
          </div>
          {captain && (
            <div className="text-right">
              <div className="text-2xl font-bold text-accent">
                {formatEp(captain.expected_points)}
              </div>
              <div className="text-xs text-secondary">xPts</div>
            </div>
          )}
        </div>
      </Card>

      {/* Chip note */}
      <Card className="mb-2 bg-[rgba(245,180,0,0.10)]">
        <p className="text-xs font-semibold uppercase tracking-wide text-warning">
          Chip status
        </p>
        <p className="mt-0.5 text-sm text-secondary">
          {chipNote ?? "No chip recommended this week — hold your chips."}
        </p>
      </Card>

      {/* Squad */}
      {entries.length === 0 ? (
        <>
          <SectionTitle>Squad</SectionTitle>
          <EmptyState
            title="No squad loaded yet"
            hint="Picks are only published by the FPL API after each gameweek deadline. Until then, enter your 15 players manually to get recommendations now."
          />
          <Link
            href="/squad/edit"
            className="mt-3 inline-flex w-full items-center justify-center rounded-lg bg-accent px-4 py-2.5 font-semibold text-on-accent sm:w-auto"
          >
            Pick your squad
          </Link>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <SectionTitle>Starting XI</SectionTitle>
            <Link
              href="/squad/edit"
              className="text-sm font-medium text-accent hover:underline"
            >
              Edit squad
            </Link>
          </div>
          <div className="space-y-1.5">
            {starters
              .slice()
              .sort(sortByEp)
              .map((e) => (
                <PlayerRow
                  key={e.player.fpl_id}
                  entry={e}
                  isCaptainRec={
                    captain?.player.fpl_id === e.player.fpl_id
                  }
                />
              ))}
          </div>

          {bench.length > 0 && (
            <>
              <SectionTitle>Bench</SectionTitle>
              <div className="space-y-1.5 opacity-70">
                {bench.slice().sort(sortByEp).map((e) => (
                  <PlayerRow key={e.player.fpl_id} entry={e} />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* Best transfer panel */}
      <SectionTitle>Best transfer targets</SectionTitle>
      <p className="mb-2 text-xs text-secondary">
        Highest projected players by position that you don&apos;t own.
      </p>
      {transfers.length === 0 ? (
        <EmptyState
          title="No suggestions yet"
          hint="Transfer targets appear once player projections have been computed for the upcoming gameweek."
        />
      ) : (
        <div className="space-y-1.5">
          {transfers.map((t) => (
            <Card key={t.player.fpl_id} className="flex items-center justify-between py-3">
              <div>
                <div className="flex items-center gap-2">
                  <Badge tone="purple">{t.position}</Badge>
                  <span className="font-semibold">{t.player.web_name}</span>
                  <span className="text-sm text-secondary">
                    {t.team?.short_name ?? ""}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-secondary">
                  {formatPrice(t.player.price)}
                </div>
              </div>
              <div className="text-right">
                <div className="font-bold text-accent">
                  {formatEp(t.expected_points)}
                </div>
                <div className="text-xs text-secondary">xPts</div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function sortByEp(a: SquadEntry, b: SquadEntry) {
  return (b.expected_points ?? -Infinity) - (a.expected_points ?? -Infinity);
}

function PlayerRow({
  entry,
  isCaptainRec = false,
}: {
  entry: SquadEntry;
  isCaptainRec?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between rounded-lg border bg-surface px-3 py-2 ${
        isCaptainRec ? "border-accent ring-1 ring-accent" : "border-subtle"
      }`}
    >
      <div className="flex items-center gap-2">
        <Badge tone="gray">{entry.player.position}</Badge>
        <span className="font-medium">{entry.player.web_name}</span>
        <span className="text-sm text-muted">
          {entry.team?.short_name ?? ""}
        </span>
        {entry.is_captain && <Badge tone="purple">C</Badge>}
        {entry.is_vice && <Badge tone="gray">V</Badge>}
        {isCaptainRec && <Badge tone="green">Rec. C</Badge>}
      </div>
      <div className="text-right">
        <span className="font-semibold text-accent">
          {formatEp(entry.expected_points)}
        </span>
        <span className="ml-1 text-xs text-muted">xPts</span>
      </div>
    </div>
  );
}
