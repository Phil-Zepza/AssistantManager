import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getNextLmsGw } from "@/lib/gameweek";
import {
  getCurrentUser,
  getLmsFixtureOptions,
  getLmsPicks,
  recommendedLmsPick,
} from "@/lib/queries";
import { formatPct } from "@/lib/format";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import type { LmsFixtureOption } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LmsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;
  const user = await getCurrentUser(userId);
  if (!user) redirect("/login");

  const lmsGw = await getNextLmsGw();
  const picks = await getLmsPicks(userId);
  const usedTeamIds = picks
    .map((p) => p.team_id)
    .filter((id): id is number => id != null);

  const usedTeamNames = new Set(usedTeamIds);

  const options = lmsGw
    ? await getLmsFixtureOptions(lmsGw.gw, usedTeamIds)
    : [];
  const rec = recommendedLmsPick(options, usedTeamIds);

  return (
    <div>
      <PageHeader
        title="Last Man Standing"
        subtitle={
          lmsGw ? `Next eligible round · GW ${lmsGw.gw}` : "No eligible round"
        }
      />

      {/* Draw = OUT reminder */}
      <div className="mb-4 rounded-xl border border-red-300 bg-red-50 p-4 text-center">
        <p className="text-sm font-bold uppercase tracking-wide text-red-700">
          ⚠️ Draw = OUT
        </p>
        <p className="mt-0.5 text-sm text-red-600">
          Your team must WIN. A draw eliminates you — back outright winners only.
        </p>
      </div>

      {rec && rec.pickTeam && (
        <Card className="mb-4 border-brand-accent ring-1 ring-brand-accent">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Recommended pick
          </p>
          <div className="mt-0.5 flex items-center justify-between">
            <span className="text-lg font-bold text-brand">
              {rec.pickTeam.name}
            </span>
            <span className="text-right">
              <span className="text-xl font-bold text-brand">
                {formatPct(rec.pickWinProb)}
              </span>
              <span className="ml-1 text-xs text-gray-500">win</span>
            </span>
          </div>
        </Card>
      )}

      {!lmsGw ? (
        <EmptyState
          title="No LMS-eligible gameweek found"
          hint="A round needs 7+ fixtures. Data appears once the pipeline has loaded the fixture list."
        />
      ) : options.length === 0 ? (
        <EmptyState
          title="No fixtures or probabilities yet"
          hint="Fixture win probabilities appear here once the model has run for this round."
        />
      ) : (
        <div className="space-y-2">
          {options.map((o) => (
            <FixtureCard
              key={o.fixture.fpl_id}
              option={o}
              isRec={rec?.fixture.fpl_id === o.fixture.fpl_id}
              usedTeamIds={usedTeamNames}
            />
          ))}
        </div>
      )}

      {usedTeamIds.length > 0 && (
        <p className="mt-6 text-center text-xs text-gray-400">
          {usedTeamIds.length} team{usedTeamIds.length === 1 ? "" : "s"} already
          used this competition and greyed out.
        </p>
      )}
    </div>
  );
}

function FixtureCard({
  option,
  isRec,
  usedTeamIds,
}: {
  option: LmsFixtureOption;
  isRec: boolean;
  usedTeamIds: Set<number>;
}) {
  const { homeTeam, awayTeam, probs, pickTeam, pickWinProb, pickIsHome } =
    option;

  const pickUsed = pickTeam ? usedTeamIds.has(pickTeam.fpl_id) : false;
  const disabled = pickUsed;

  return (
    <div
      className={`rounded-xl border p-3 ${
        isRec
          ? "border-brand-accent bg-white ring-1 ring-brand-accent"
          : "border-gray-200 bg-white"
      } ${disabled ? "opacity-40" : ""}`}
      aria-disabled={disabled}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`font-semibold ${
                pickIsHome ? "text-brand" : "text-gray-700"
              }`}
            >
              {homeTeam?.short_name ?? "TBD"}
            </span>
            <span className="text-xs text-gray-400">v</span>
            <span
              className={`font-semibold ${
                !pickIsHome ? "text-brand" : "text-gray-700"
              }`}
            >
              {awayTeam?.short_name ?? "TBD"}
            </span>
            {isRec && !disabled && <Badge tone="green">Pick</Badge>}
            {disabled && <Badge tone="gray">Used</Badge>}
          </div>
          <div className="mt-1 flex gap-3 text-xs text-gray-500">
            <span>H {formatPct(probs?.p_home)}</span>
            <span>D {formatPct(probs?.p_draw)}</span>
            <span>A {formatPct(probs?.p_away)}</span>
          </div>
        </div>
        <div className="ml-3 text-right">
          <div className="text-xs text-gray-400">back</div>
          <div className="font-semibold">
            {pickTeam?.short_name ?? "—"}
          </div>
          <div className="text-sm font-bold text-brand">
            {formatPct(pickWinProb)}
          </div>
        </div>
      </div>
    </div>
  );
}
