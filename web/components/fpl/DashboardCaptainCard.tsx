"use client";

import { useState } from "react";
import { Crown } from "lucide-react";
import {
  BottomSheet,
  Card,
  ClubBadge,
  PositionTag,
  StatBlock,
} from "@/components/ui";
import { formatEp, formatPrice } from "@/lib/format";
import { projectAsCaptain } from "@/lib/projections";
import type { SquadEntry } from "@/lib/types";
import { CaptainCompare } from "./CaptainCompare";

export interface DashboardCaptainCardProps {
  captain: SquadEntry;
  entries: SquadEntry[];
  /** One-line rationale for the suggestion. */
  rationale: string;
}

/**
 * "Captain this week" — a read-only VERDICT (not a control). The armband is the
 * model's suggestion; the only action is to compare candidates. Nothing here
 * sets a captain; the user captains in the FPL app.
 */
export function DashboardCaptainCard({
  captain,
  entries,
  rationale,
}: DashboardCaptainCardProps) {
  const [compareOpen, setCompareOpen] = useState(false);
  const p = captain.player;
  const projected = projectAsCaptain(captain.expected_points);

  return (
    <>
      <Card selected className="mb-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
          Captain this week
        </p>
        <div className="flex items-center gap-3">
          <span className="relative shrink-0">
            <ClubBadge code={captain.team?.short_name} size={44} state="recommended" />
            <span
              className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full text-[11px] font-black text-white ring-2 ring-surface"
              style={{ background: "var(--accent-2)" }}
              aria-hidden
            >
              C
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-lg font-bold text-primary">
                {p.web_name}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-hot/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-hot">
                <Crown className="h-3 w-3" aria-hidden /> Suggested
              </span>
            </div>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-secondary">
              <PositionTag pos={p.position} size="sm" /> {formatPrice(p.price)}
            </p>
          </div>
          <StatBlock
            label="Projected"
            value={formatEp(projected)}
            unit="xPts"
            emphasis="hot"
            size="lg"
            align="right"
          />
        </div>

        <p className="mt-3 text-sm text-secondary">{rationale}</p>

        <button
          type="button"
          onClick={() => setCompareOpen(true)}
          className="mt-3 text-sm font-semibold text-accent hover:underline"
        >
          Compare captains →
        </button>
      </Card>

      <BottomSheet
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        title="Compare captains"
      >
        <p className="mb-3 text-sm text-secondary">
          Ranked by projected points (EP × 2). #1 is the model&apos;s suggested
          pick — this is a projection, not a setting.
        </p>
        <CaptainCompare entries={entries} focusPlayerId={p.fpl_id} />
      </BottomSheet>
    </>
  );
}
