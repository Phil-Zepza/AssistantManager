import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getNextLmsGw } from "@/lib/gameweek";
import {
  getAllTeams,
  getCurrentUser,
  getLmsFixtureOptions,
  getLmsPicks,
  getUpcomingGameweeks,
} from "@/lib/queries";
import { buildDemoEntry, buildPrimaryEntry } from "@/lib/lms";
import { PageHeader } from "@/components/ui";
import { LmsCanvas } from "@/components/lms/LmsCanvas";
import type { LmsEntry, Team } from "@/lib/types";

export const dynamic = "force-dynamic";

const COMPETITION_NAME = "Sphinx LMS 2026/27";

// Competition-wide survivor counts have no data source yet (we don't ingest
// other entrants' picks). Rendered from a clearly-typed placeholder.
// TODO wire: derive from real competition standings once ingested.
const SURVIVORS_PLACEHOLDER = 38;
const TOTAL_ENTRANTS_PLACEHOLDER = 120;

export default async function LmsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;
  const user = await getCurrentUser(userId);
  if (!user) redirect("/login");

  const lmsGw = await getNextLmsGw();
  const roundGw = lmsGw?.gw ?? null;

  // Real reads. Picks are user-scoped; teams/fixtures/gameweeks are reference
  // data. Used teams (for the current round's options) come from the primary
  // entry's real picks so a spent team is excluded up front too.
  const [picks, allTeams, upcoming] = await Promise.all([
    getLmsPicks(userId),
    getAllTeams(),
    getUpcomingGameweeks(roundGw, 14),
  ]);

  const teamsById = new Map<number, Team>(allTeams.map((t) => [t.fpl_id, t]));
  const primaryEntry = buildPrimaryEntry(picks, teamsById);
  const demoEntry = buildDemoEntry(teamsById);
  const entries: LmsEntry[] = [primaryEntry, demoEntry];

  const usedTeamIds = primaryEntry.picks
    .map((p) => p.team?.fpl_id)
    .filter((id): id is number => id != null);

  const options = roundGw != null
    ? await getLmsFixtureOptions(roundGw, usedTeamIds)
    : [];

  return (
    <div>
      <PageHeader
        title="Last Man Standing"
        subtitle={
          roundGw != null
            ? `${COMPETITION_NAME} · next qualifying round GW${roundGw}`
            : COMPETITION_NAME
        }
      />
      <LmsCanvas
        competitionName={COMPETITION_NAME}
        roundGw={roundGw}
        entries={entries}
        options={options}
        allTeams={allTeams}
        upcoming={upcoming}
        survivorsPlaceholder={SURVIVORS_PLACEHOLDER}
        totalEntrantsPlaceholder={TOTAL_ENTRANTS_PLACEHOLDER}
      />
    </div>
  );
}
