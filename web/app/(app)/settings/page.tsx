import Link from "next/link";
import { redirect } from "next/navigation";
import { Users } from "lucide-react";
import { auth } from "@/auth";
import { getCurrentUser, getLmsPicks, getTeamsByIds } from "@/lib/queries";
import { getSeasonHistory, summariseLms, teamTag } from "@/lib/profile";
import { signOutAction } from "@/app/actions";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  SectionTitle,
} from "@/components/ui";
import EditProfileSheet from "@/components/profile/EditProfileSheet";
import type {
  LmsStatus,
  LmsSummary,
  SeasonHistoryRow,
  User,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const user = await getCurrentUser(session.user.id);
  if (!user) redirect("/login");

  // Reuse existing user + LMS queries; season history comes from a server-side
  // FPL read (see lib/profile). Everything degrades to an empty state.
  const [seasonHistory, lmsPicks] = await Promise.all([
    getSeasonHistory(user.fpl_entry_id),
    getLmsPicks(user.id),
  ]);
  const teamIds = Array.from(
    new Set(lmsPicks.map((p) => p.team_id).filter((id): id is number => id != null)),
  );
  const teams = await getTeamsByIds(teamIds);
  const teamsById = new Map(teams.map((t) => [t.fpl_id, t]));
  const lms = summariseLms(lmsPicks, teamsById);

  return (
    <div>
      <PageHeader title="Profile" subtitle="Your account, seasons and LMS run." />

      <ProfileHeaderCard user={user} />

      {/* Desktop: season history + LMS side by side within the centred column. */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <SeasonHistoryCard rows={seasonHistory} linked={user.fpl_entry_id != null} />
        <LmsCard summary={lms} />
      </div>

      <SectionTitle>Squad</SectionTitle>
      <Card className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="font-semibold text-primary">Your squad</p>
          <p className="mt-0.5 text-sm text-secondary">
            Enter or edit your 15 players manually.
          </p>
        </div>
        <Link href="/squad/edit" className="shrink-0">
          <Button size="sm" icon={<Users />}>
            Pick squad
          </Button>
        </Link>
      </Card>

      <div className="mt-6">
        <form action={signOutAction}>
          <Button type="submit" variant="secondary" fullWidth>
            Sign out
          </Button>
        </form>
      </div>
    </div>
  );
}

// ---- Header card: avatar, name, team tag, FPL id, Edit ----

function ProfileHeaderCard({ user }: { user: User }) {
  const name = user.display_name?.trim() || user.name?.trim() || "Manager";
  const initial =
    (user.display_name?.trim() ||
      user.name?.trim() ||
      user.email?.trim() ||
      "M")[0]?.toUpperCase() ?? "M";

  return (
    <Card padding="lg">
      <div className="flex items-center gap-4">
        <span
          className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-surface-2 text-2xl font-bold text-primary ring-1 ring-strong"
          aria-hidden
        >
          {initial}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-xl font-bold text-primary">{name}</h2>
            <Badge tone="accent">{teamTag()}</Badge>
          </div>
          <p className="mt-1 text-sm text-secondary">
            FPL ID{" "}
            {user.fpl_entry_id != null ? (
              <span className="tnum font-semibold text-primary">
                {user.fpl_entry_id}
              </span>
            ) : (
              <span className="text-muted">not linked</span>
            )}
          </p>
          {user.email && (
            <p className="truncate text-xs text-muted" title={user.email}>
              {user.email}
            </p>
          )}
        </div>

        <div className="shrink-0 self-start">
          <EditProfileSheet user={user} />
        </div>
      </div>
    </Card>
  );
}

// ---- Season history table ----

function fmtRank(n: number | null): string {
  return n != null ? n.toLocaleString("en-GB") : "—";
}
function fmtPoints(n: number | null): string {
  return n != null ? n.toLocaleString("en-GB") : "—";
}

function SeasonHistoryCard({
  rows,
  linked,
}: {
  rows: SeasonHistoryRow[];
  linked: boolean;
}) {
  return (
    <Card>
      <SectionTitle className="mb-3 mt-0">Season history</SectionTitle>
      {rows.length === 0 ? (
        <EmptyState
          title="No season history yet"
          hint={
            linked
              ? "We couldn't load past seasons from FPL right now — check back after the next update."
              : "Link your FPL team to see your past seasons and current rank."
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-subtle text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3 font-medium">Season</th>
                <th className="py-2 px-3 text-right font-medium">Overall rank</th>
                <th className="py-2 pl-3 text-right font-medium">Points</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.season}
                  className="border-b border-subtle last:border-0"
                >
                  <td className="py-2.5 pr-3">
                    <span className="font-medium text-primary">{r.season}</span>
                    {r.isCurrent && (
                      <Badge tone="accent" className="ml-2 align-middle">
                        Current
                      </Badge>
                    )}
                  </td>
                  <td className="tnum py-2.5 px-3 text-right text-secondary">
                    {fmtRank(r.overallRank)}
                  </td>
                  <td className="tnum py-2.5 pl-3 text-right font-semibold text-primary">
                    {fmtPoints(r.points)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---- LMS card ----

const LMS_TONE: Record<LmsStatus, "success" | "danger" | "gray"> = {
  alive: "success",
  out: "danger",
  pending: "gray",
};
const LMS_LABEL: Record<LmsStatus, string> = {
  alive: "Alive",
  out: "Out",
  pending: "Pending",
};

function LmsCard({ summary }: { summary: LmsSummary }) {
  return (
    <Card>
      <SectionTitle
        className="mb-3 mt-0"
        right={
          summary.entries > 0 ? (
            <Badge tone={summary.alive ? "success" : "danger"}>
              {summary.alive ? "Still in" : "Knocked out"}
            </Badge>
          ) : undefined
        }
      >
        Your LMS
      </SectionTitle>

      {summary.entries === 0 ? (
        <EmptyState
          title="No LMS picks yet"
          hint="Your Last Man Standing picks will appear here once a round is played."
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-secondary">
            <span className="tnum font-semibold text-primary">
              {summary.entries}
            </span>{" "}
            {summary.entries === 1 ? "round" : "rounds"} played
          </p>
          <ul className="space-y-1.5">
            {summary.rounds.map((r) => (
              <li
                key={r.round_gw}
                className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-2 text-sm"
              >
                <span className="text-secondary">
                  <span className="tnum">GW {r.round_gw}</span>
                  {r.teamShort && (
                    <span className="ml-2 font-medium text-primary">
                      {r.teamShort}
                    </span>
                  )}
                </span>
                <Badge tone={LMS_TONE[r.status]}>{LMS_LABEL[r.status]}</Badge>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
