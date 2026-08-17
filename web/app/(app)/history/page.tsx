import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getCurrentUser, getHistoryEntries } from "@/lib/queries";
import { getCurrentGw } from "@/lib/gameweek";
import { PageHeader } from "@/components/ui";
import { HistoryCanvas } from "@/components/history/HistoryCanvas";
import type { AccuracyStats, HistoryEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

// Canonical outcome keys: "hit" (FPL recs) and "survived" (LMS recs).
// Legacy aliases "correct" / "success" / "won" are intentionally omitted —
// nothing writes them, and having them in the lookup added ambiguity.
function isCorrect(outcome: Record<string, unknown> | null): boolean | null {
  if (!outcome) return null;
  if ("hit" in outcome && typeof outcome.hit === "boolean") return outcome.hit;
  if ("survived" in outcome && typeof outcome.survived === "boolean")
    return outcome.survived;
  return null;
}

function computeStats(entries: HistoryEntry[]): AccuracyStats {
  const resolved = entries.filter((e) => e.outcome !== null);
  const correct = resolved.filter((e) => isCorrect(e.outcome) === true).length;
  const hitRate = resolved.length > 0 ? correct / resolved.length : null;

  let trend: number | null = null;
  if (resolved.length >= 5 && hitRate !== null) {
    const recent = resolved.slice(0, 5);
    const recentCorrect = recent.filter(
      (e) => isCorrect(e.outcome) === true,
    ).length;
    trend = recentCorrect / 5 - hitRate;
  }

  const byKind: AccuracyStats["byKind"] = {
    fpl_captain: { correct: 0, resolved: 0 },
    fpl_transfer: { correct: 0, resolved: 0 },
    lms_pick: { correct: 0, resolved: 0 },
  };

  for (const e of resolved) {
    if (
      e.kind === "fpl_captain" ||
      e.kind === "fpl_transfer" ||
      e.kind === "lms_pick"
    ) {
      byKind[e.kind].resolved++;
      if (isCorrect(e.outcome) === true) byKind[e.kind].correct++;
    }
  }

  return {
    total: entries.length,
    resolved: resolved.length,
    correct,
    hitRate,
    trend,
    byKind,
  };
}

export default async function HistoryPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;
  const user = await getCurrentUser(userId);
  if (!user) redirect("/login");

  const [entries, currentGwData] = await Promise.all([
    getHistoryEntries(userId),
    getCurrentGw(),
  ]);

  const stats = computeStats(entries);

  return (
    <div>
      <PageHeader
        title="History"
        subtitle="What we recommended, and how it turned out."
      />
      <HistoryCanvas
        entries={entries}
        stats={stats}
        currentGw={currentGwData?.gw ?? null}
      />
    </div>
  );
}
