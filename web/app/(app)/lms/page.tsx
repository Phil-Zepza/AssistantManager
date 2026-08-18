import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getNextLmsGw } from "@/lib/gameweek";
import {
  getAllTeams,
  getCompetitions,
  getCompetition,
  getCompetitionSpreadView,
  getEntry,
  getGameweekFixtures,
  getForwardPlanInputs,
  getTeamScouting,
} from "@/lib/queries";
import { LmsCanvas } from "@/components/lms/LmsCanvas";

export const dynamic = "force-dynamic";

export default async function LmsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const [competitions, allTeams] = await Promise.all([
    getCompetitions(userId),
    getAllTeams(),
  ]);

  const rawComp = searchParams.comp;
  const compIdParam =
    typeof rawComp === "string" ? parseInt(rawComp, 10) : null;

  let compDetail = null;

  if (compIdParam != null && Number.isInteger(compIdParam) && compIdParam > 0) {
    const [comp, lmsGw] = await Promise.all([
      getCompetition(compIdParam, userId),
      getNextLmsGw(),
    ]);

    if (comp) {
      const currentGw = lmsGw?.gw ?? null;

      const fixtures =
        currentGw != null ? await getGameweekFixtures(currentGw) : [];

      const teamIds = [
        ...new Set(
          fixtures.flatMap((f) =>
            [f.homeTeam?.fpl_id, f.awayTeam?.fpl_id].filter(
              (id): id is number => id != null,
            ),
          ),
        ),
      ];
      const teamStats = await getTeamScouting(teamIds);

      const [entriesData, spreadView] = await Promise.all([
        Promise.all(
          comp.entries.map(async (e) => {
            const [detail, planInputs] = await Promise.all([
              getEntry(e.id, userId),
              getForwardPlanInputs(e.id, userId),
            ]);
            return { detail, planInputs };
          }),
        ),
        currentGw != null
          ? getCompetitionSpreadView(compIdParam, userId, currentGw)
          : Promise.resolve(null),
      ]);

      const entries = entriesData.filter(
        (e): e is { detail: NonNullable<typeof e.detail>; planInputs: typeof e.planInputs } =>
          e.detail != null,
      );

      compDetail = {
        competition: comp,
        fixtures,
        entries,
        teamStats,
        currentGw,
        firstEntryId: comp.entries[0]?.id ?? 0,
        spreadView,
      };
    }
  }

  return (
    <LmsCanvas
      competitions={competitions}
      compDetail={compDetail}
      allTeams={allTeams}
    />
  );
}
