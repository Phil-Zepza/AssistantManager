import { ClubBadge, PositionTag, StatBlock } from "@/components/ui";
import { formatEp, formatSignedEp } from "@/lib/format";
import { captainCandidates, projectAsCaptain } from "@/lib/projections";
import { cn } from "@/lib/cn";
import type { SquadEntry } from "@/lib/types";

export interface CaptainCompareProps {
  entries: SquadEntry[];
  /** Highlight the player this comparison was opened for (optional). */
  focusPlayerId?: number;
  limit?: number;
}

/**
 * Ranked mini-comparison of the user's top captain candidates by PROJECTED
 * points (EP × 2). #1 is dominant — it's the model's suggested pick. Purely a
 * read-only verdict: nothing here sets a captain.
 */
export function CaptainCompare({
  entries,
  focusPlayerId,
  limit = 3,
}: CaptainCompareProps) {
  const ranked = captainCandidates(entries, limit);
  if (ranked.length === 0) {
    return (
      <p className="text-sm text-secondary">
        No projections available to compare yet.
      </p>
    );
  }

  const top = ranked[0];
  const topProj = projectAsCaptain(top.expected_points) ?? 0;

  return (
    <ol className="space-y-2">
      {ranked.map((e, i) => {
        const proj = projectAsCaptain(e.expected_points);
        const isTop = i === 0;
        const gap = i === 0 ? null : (proj ?? 0) - topProj; // negative
        const focused = focusPlayerId === e.player.fpl_id;
        return (
          <li
            key={e.player.fpl_id}
            className={cn(
              "flex items-center gap-3 rounded-lg border px-3 py-2.5",
              isTop
                ? "border-hot/60 bg-[rgba(255,45,120,0.08)]"
                : "border-subtle bg-surface",
              focused && !isTop && "ring-1 ring-accent",
            )}
          >
            <span
              className={cn(
                "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold tnum",
                isTop ? "bg-hot text-white" : "bg-surface-2 text-secondary",
              )}
              aria-hidden
            >
              {i + 1}
            </span>
            <ClubBadge code={e.team?.short_name} size={24} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-semibold text-primary">
                  {e.player.web_name}
                </span>
                <PositionTag pos={e.player.position} size="sm" />
                {isTop && (
                  <span className="rounded-full bg-hot/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-hot">
                    Top pick
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {gap == null
                  ? `${formatEp(e.expected_points)} xPts base`
                  : `${formatSignedEp(gap)} vs top`}
              </p>
            </div>
            <StatBlock
              label="proj"
              value={formatEp(proj)}
              align="right"
              size="sm"
              emphasis={isTop ? "hot" : "none"}
            />
          </li>
        );
      })}
    </ol>
  );
}
