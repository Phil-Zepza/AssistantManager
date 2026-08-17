"use client";

import { useMemo } from "react";
import { ArrowLeftRight, BarChart3, Crown, Users } from "lucide-react";
import { BottomSheet, ClubBadge, PositionTag, StatBlock } from "@/components/ui";
import {
  formatEp,
  formatPct,
  formatPrice,
  formatSignedEp,
} from "@/lib/format";
import {
  captainCandidates,
  captainProjection,
  currentCaptain,
  simulateTransferOut,
} from "@/lib/projections";
import type { PickPoolEntry, SquadEntry } from "@/lib/types";
import { cn } from "@/lib/cn";
import { CaptainCompare } from "./CaptainCompare";
import { DisclosureSection } from "./DisclosureSection";
import { TransferProjectionView } from "./TransferProjectionView";

export interface PlayerDecisionSheetProps {
  open: boolean;
  onClose: () => void;
  /** The player the sheet is about. Null while closed. */
  entry: SquadEntry | null;
  /** The full 15-man squad — for captain comparison + current captain. */
  entries: SquadEntry[];
  /** Selectable pool — for the like-for-like transfer simulation. */
  pool: PickPoolEntry[];
}

/**
 * The decision sheet: it helps you DECIDE, it never edits. Every control is a
 * read-only projection — Project-as-captain, Compare captains, Simulate a
 * transfer out, View stats. There is deliberately no Make captain / Make vice /
 * Replace / Remove button anywhere: this app never writes to FPL.
 */
export function PlayerDecisionSheet({
  open,
  onClose,
  entry,
  entries,
  pool,
}: PlayerDecisionSheetProps) {
  const recommended = useMemo(
    () => captainCandidates(entries, 1)[0] ?? null,
    [entries],
  );
  const current = useMemo(() => currentCaptain(entries), [entries]);

  const capProj = useMemo(
    () => (entry ? captainProjection(entry, current, recommended) : null),
    [entry, current, recommended],
  );

  const ownedIds = useMemo(() => entries.map((e) => e.player.fpl_id), [entries]);
  const transfer = useMemo(
    () => (entry ? simulateTransferOut(entry, pool, ownedIds) : null),
    [entry, pool, ownedIds],
  );

  // Next-fixture / richer stats live in the pool (SquadEntry has none).
  const poolEntry = useMemo(
    () =>
      entry
        ? pool.find((p) => p.player.fpl_id === entry.player.fpl_id) ?? null
        : null,
    [entry, pool],
  );

  if (!entry) return null;

  const p = entry.player;
  const isRecommendedCaptain = recommended?.player.fpl_id === p.fpl_id;
  const onBench = entry.on_bench;

  return (
    <BottomSheet open={open} onClose={onClose} title="Player options">
      {/* ---- header ---- */}
      <div className="flex items-center gap-3 pb-1">
        <ClubBadge
          code={entry.team?.short_name}
          size={44}
          state={isRecommendedCaptain ? "recommended" : "default"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-lg font-bold text-primary">
              {p.web_name}
            </h3>
            <PositionTag pos={p.position} size="sm" />
            {isRecommendedCaptain && (
              <span className="inline-flex items-center gap-1 rounded-full bg-hot/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-hot">
                <Crown className="h-3 w-3" aria-hidden /> C · Suggested
              </span>
            )}
            {onBench && (
              <span className="rounded-full bg-[rgba(255,255,255,0.06)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                Bench
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-secondary">
            {entry.team?.name ?? p.position} · {formatPrice(p.price)}
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-2.5">
        {/* ---- Project as captain ---- */}
        <DisclosureSection
          primary
          defaultOpen={!onBench}
          icon={<Crown className="h-4 w-4" />}
          title="Project as captain"
          summary={capProj?.projected != null ? `${formatEp(capProj.projected)} xPts` : "—"}
        >
          <div className="space-y-3">
            <div className="flex items-end justify-between gap-3">
              <StatBlock
                label="Projected (C)"
                value={formatEp(capProj?.projected)}
                unit="xPts"
                emphasis="hot"
                size="lg"
              />
              <div className="space-y-1 text-right text-sm">
                {capProj?.vsCurrent != null && current && (
                  <p className="text-secondary">
                    <span
                      className={cn(
                        "font-semibold tnum",
                        capProj.vsCurrent > 0 ? "text-success" : "text-danger",
                      )}
                    >
                      {formatSignedEp(capProj.vsCurrent)}
                    </span>{" "}
                    vs your captain ({current.player.web_name}{" "}
                    {formatEp(current.expected_points)})
                  </p>
                )}
                {capProj?.isRecommended ? (
                  <p className="font-semibold text-hot">Model&apos;s top pick</p>
                ) : (
                  capProj?.vsRecommended != null &&
                  recommended && (
                    <p className="text-secondary">
                      <span className="font-semibold tnum text-danger">
                        {formatSignedEp(capProj.vsRecommended)}
                      </span>{" "}
                      vs pick ({recommended.player.web_name})
                    </p>
                  )
                )}
              </div>
            </div>
            <p className="rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-muted">
              1-GW projection · multi-GW horizon — TODO wire (EP is horizon 1
              only). This is a what-if — it sets nothing.
            </p>
          </div>
        </DisclosureSection>

        {/* ---- Compare captains ---- */}
        <DisclosureSection
          defaultOpen={false}
          icon={<Users className="h-4 w-4" />}
          title="Compare captains"
          summary={
            recommended ? `${recommended.player.web_name} top` : undefined
          }
        >
          <CaptainCompare entries={entries} focusPlayerId={p.fpl_id} />
        </DisclosureSection>

        {/* ---- Simulate transfer out ---- */}
        <DisclosureSection
          defaultOpen={onBench}
          icon={<ArrowLeftRight className="h-4 w-4" />}
          title="Simulate transfer out"
          summary={
            transfer?.epSwing != null
              ? `${formatSignedEp(transfer.epSwing)} xPts`
              : undefined
          }
        >
          {transfer ? (
            <TransferProjectionView projection={transfer} />
          ) : (
            <p className="text-sm text-secondary">
              No like-for-like replacement with a projection is available right
              now.
            </p>
          )}
        </DisclosureSection>

        {/* ---- View stats (pure read) ---- */}
        <DisclosureSection
          defaultOpen={false}
          icon={<BarChart3 className="h-4 w-4" />}
          title="View stats"
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
            <Stat label="Projected (1 GW)" value={`${formatEp(entry.expected_points)} xPts`} />
            <Stat label="Price" value={formatPrice(p.price)} />
            <Stat label="Form" value={p.form != null ? p.form.toFixed(1) : "—"} />
            <Stat
              label="Owned by"
              value={formatPct(p.selected_by != null ? p.selected_by / 100 : null)}
            />
            <Stat label="Next up" value={<NextFixture entry={poolEntry} />} />
            <Stat
              label="Status"
              value={
                p.status == null || p.status === "a"
                  ? p.chance_next != null && p.chance_next < 100
                    ? `${p.chance_next}% fit`
                    : "Available"
                  : p.chance_next != null
                    ? `${p.chance_next}% chance`
                    : "Doubtful"
              }
            />
          </dl>
        </DisclosureSection>
      </div>
    </BottomSheet>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 font-semibold text-primary">{value}</dd>
    </div>
  );
}

function NextFixture({ entry }: { entry: PickPoolEntry | null }) {
  const nf = entry?.next_fixture;
  if (!nf || !nf.opponent?.short_name) return <span>—</span>;
  return (
    <span>
      {nf.opponent.short_name} {nf.is_home ? "(H)" : "(A)"}
    </span>
  );
}
