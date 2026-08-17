"use client";

import { useState, useMemo } from "react";
import type { ReactNode } from "react";
import { Star, ArrowLeftRight, Shield, Zap, LayoutGrid } from "lucide-react";
import {
  Badge,
  BottomSheet,
  Callout,
  Card,
  Chip,
  ClubBadge,
  EmptyState,
  SegmentedControl,
  SectionTitle,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import type { AccuracyStats, HistoryEntry, RecommendationKind } from "@/lib/types";

// ---- Constants ----

type Segment = "all" | "fpl" | "lms";

const FPL_KINDS = new Set<RecommendationKind>([
  "fpl_captain",
  "fpl_transfer",
  "fpl_xi",
  "chip",
]);
const LMS_KINDS = new Set<RecommendationKind>(["lms_pick"]);

const KIND_LABEL: Record<RecommendationKind, string> = {
  fpl_xi: "Starting XI",
  fpl_transfer: "Transfer",
  fpl_captain: "Captain",
  lms_pick: "LMS Pick",
  chip: "Chip",
};

function getKindIcon(kind: RecommendationKind): ReactNode {
  switch (kind) {
    case "fpl_captain":
      return <Star className="h-3.5 w-3.5" />;
    case "fpl_transfer":
      return <ArrowLeftRight className="h-3.5 w-3.5" />;
    case "fpl_xi":
      return <LayoutGrid className="h-3.5 w-3.5" />;
    case "lms_pick":
      return <Shield className="h-3.5 w-3.5" />;
    case "chip":
      return <Zap className="h-3.5 w-3.5" />;
    default:
      return null;
  }
}

// ---- Outcome helpers (canonical: "hit" for FPL, "survived" for LMS) ----

function isCorrect(outcome: Record<string, unknown> | null): boolean | null {
  if (!outcome) return null;
  if ("hit" in outcome && typeof outcome.hit === "boolean") return outcome.hit;
  if ("survived" in outcome && typeof outcome.survived === "boolean")
    return outcome.survived;
  return null;
}

function getRecSummary(entry: HistoryEntry): string {
  switch (entry.kind) {
    case "fpl_captain": {
      const ep =
        typeof entry.payload?.expected_points === "number"
          ? ` · EP ${(entry.payload.expected_points as number).toFixed(1)}`
          : "";
      return entry.player_name
        ? `Captain ${entry.player_name}${ep}`
        : "Captain pick";
    }
    case "fpl_transfer":
      return entry.player_name
        ? `Transfer in ${entry.player_name}`
        : "Transfer suggestion";
    case "lms_pick": {
      const prob =
        typeof entry.payload?.win_prob === "number"
          ? ` · ${Math.round((entry.payload.win_prob as number) * 100)}% win`
          : "";
      return entry.team_name ? `Pick ${entry.team_name}${prob}` : "LMS pick";
    }
    case "fpl_xi":
      return "Starting XI recommendation";
    case "chip": {
      const chip = entry.payload?.chip;
      return chip ? `Play ${chip} chip` : "Chip suggestion";
    }
    default:
      return "Recommendation";
  }
}

function getWhatHappened(entry: HistoryEntry): string | null {
  const o = entry.outcome;
  if (!o) return null;
  switch (entry.kind) {
    case "fpl_captain": {
      const pts =
        typeof o.actual_points === "number"
          ? `${o.actual_points} pts scored`
          : null;
      if (pts) return pts;
      const hit = isCorrect(o);
      return hit === true
        ? "Captaincy paid off"
        : hit === false
          ? "Captaincy missed"
          : null;
    }
    case "fpl_transfer": {
      const pts =
        typeof o.actual_points === "number"
          ? `${o.actual_points} pts scored this GW`
          : null;
      if (pts) return pts;
      const hit = isCorrect(o);
      return hit === true
        ? "Good transfer"
        : hit === false
          ? "Transfer didn't pay off"
          : null;
    }
    case "lms_pick": {
      const result =
        typeof o.result === "string" ? (o.result as string) : null;
      const survived = isCorrect(o);
      const parts: string[] = [];
      if (result)
        parts.push(`Result: ${result.charAt(0).toUpperCase() + result.slice(1)}`);
      if (survived !== null)
        parts.push(survived ? "Survived ✓" : "Eliminated ✗");
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    default:
      return null;
  }
}

function getVerdict(
  entry: HistoryEntry,
): { tone: "success" | "danger"; title: string; body: string } | null {
  const correct = isCorrect(entry.outcome);
  if (correct === null) return null;
  if (correct) {
    return {
      tone: "success",
      title: "Right call",
      body:
        entry.kind === "lms_pick"
          ? "You survived this round."
          : "The recommendation paid off.",
    };
  }
  return {
    tone: "danger",
    title: "Wrong call",
    body:
      entry.kind === "lms_pick"
        ? "You were eliminated this round."
        : "The recommendation didn't pay off.",
  };
}

// ---- Sub-components ----

function OutcomeBadge({ entry }: { entry: HistoryEntry }) {
  const correct = isCorrect(entry.outcome);
  if (entry.outcome === null) return <Badge tone="amber">Pending</Badge>;
  if (correct === true) return <Badge tone="success">Hit ✓</Badge>;
  if (correct === false) return <Badge tone="danger">Miss ✗</Badge>;
  return <Badge tone="gray">Resolved</Badge>;
}

// Frame 1 — accuracy tally card.
function AccuracyCard({ stats }: { stats: AccuracyStats }) {
  const hitPct =
    stats.hitRate !== null ? Math.round(stats.hitRate * 100) : null;
  const trendPct =
    stats.trend !== null ? Math.round(stats.trend * 100) : null;

  const categories = [
    { label: "Captain calls", ...stats.byKind.fpl_captain },
    { label: "Transfer calls", ...stats.byKind.fpl_transfer },
    { label: "LMS survival", ...stats.byKind.lms_pick },
  ];

  return (
    <Card className="mb-4">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Recommendations hit rate
          </p>
          <div className="flex items-center gap-2">
            <span className="tnum text-4xl font-bold text-accent">
              {hitPct !== null ? `${hitPct}%` : "—"}
            </span>
            {trendPct !== null && (
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                  trendPct > 0
                    ? "bg-[rgba(34,197,94,0.15)] text-success"
                    : trendPct < 0
                      ? "bg-[rgba(244,63,94,0.15)] text-danger"
                      : "bg-[rgba(255,255,255,0.06)] text-secondary",
                )}
              >
                {trendPct > 0
                  ? `▲ +${trendPct}pp`
                  : trendPct < 0
                    ? `▼ ${trendPct}pp`
                    : "→ flat"}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {stats.correct} of {stats.resolved} resolved
          </p>
        </div>
        <span className="text-xs text-muted">{stats.total} logged</span>
      </div>

      <div className="space-y-2.5">
        {categories.map(({ label, resolved, correct }) => {
          const pct =
            resolved > 0 ? Math.round((correct / resolved) * 100) : null;
          return (
            <div key={label}>
              <div className="mb-1 flex justify-between text-xs">
                <span className="text-secondary">{label}</span>
                <span className="tnum text-muted">
                  {pct !== null ? `${pct}% (${correct}/${resolved})` : "—"}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// Frame 2 — a single log row (mobile card or desktop table row).
interface RecRowProps {
  entry: HistoryEntry;
  onSelect: (entry: HistoryEntry) => void;
  desktop?: boolean;
}

function RecRow({ entry, onSelect, desktop = false }: RecRowProps) {
  const summary = getRecSummary(entry);
  const icon = getKindIcon(entry.kind);
  const label = KIND_LABEL[entry.kind];

  if (desktop) {
    return (
      <tr
        className="cursor-pointer border-b border-subtle transition-colors hover:bg-raised"
        onClick={() => onSelect(entry)}
      >
        <td className="tnum whitespace-nowrap px-4 py-3 text-sm text-muted">
          GW {entry.gw}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            <span className="text-muted">{icon}</span>
            <span className="text-sm text-secondary">{label}</span>
          </div>
        </td>
        <td className="max-w-xs px-4 py-3 text-sm text-primary">{summary}</td>
        <td className="px-4 py-3">
          <OutcomeBadge entry={entry} />
        </td>
      </tr>
    );
  }

  return (
    <button
      type="button"
      className="w-full text-left"
      onClick={() => onSelect(entry)}
    >
      <Card className="flex items-center justify-between transition-colors hover:border-strong">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
            {icon}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-primary">{summary}</p>
            <p className="mt-0.5 text-xs text-muted">{label}</p>
          </div>
        </div>
        <div className="ml-3 shrink-0">
          <OutcomeBadge entry={entry} />
        </div>
      </Card>
    </button>
  );
}

// Frame 3 — row detail BottomSheet.
function RecDetailSheet({
  entry,
  onClose,
}: {
  entry: HistoryEntry | null;
  onClose: () => void;
}) {
  const correct = entry ? isCorrect(entry.outcome) : null;
  const whatHappened = entry ? getWhatHappened(entry) : null;
  const verdict = entry ? getVerdict(entry) : null;

  return (
    <BottomSheet
      open={entry !== null}
      onClose={onClose}
      title={
        entry ? `GW ${entry.gw} · ${KIND_LABEL[entry.kind]}` : undefined
      }
    >
      {entry && (
        <div className="space-y-4">
          {/* What we said */}
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              What we said
            </p>
            <blockquote className="border-l-2 border-accent pl-3 text-sm italic text-primary">
              &ldquo;{getRecSummary(entry)}&rdquo;
            </blockquote>
          </div>

          {/* What happened */}
          {whatHappened && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                What happened
              </p>
              <div className="flex items-center gap-3">
                {entry.kind === "lms_pick" && entry.team_short_name && (
                  <ClubBadge
                    code={entry.team_short_name}
                    size={32}
                    state={
                      correct === true
                        ? "recommended"
                        : correct === false
                          ? "out"
                          : "default"
                    }
                  />
                )}
                <p className="text-sm text-primary">{whatHappened}</p>
              </div>
            </div>
          )}

          {/* Pending notice */}
          {entry.outcome === null && (
            <Callout tone="info" title="Pending">
              This recommendation hasn&apos;t been resolved yet — outcome
              appears after the gameweek finishes.
            </Callout>
          )}

          {/* Verdict */}
          {verdict && (
            <Callout tone={verdict.tone} title={verdict.title}>
              {verdict.body}
            </Callout>
          )}
        </div>
      )}
    </BottomSheet>
  );
}

// ---- Utility ----

function groupByGw(
  entries: HistoryEntry[],
): { gw: number; rows: HistoryEntry[] }[] {
  const map = new Map<number, HistoryEntry[]>();
  for (const e of entries) {
    const bucket = map.get(e.gw);
    if (bucket) bucket.push(e);
    else map.set(e.gw, [e]);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => b - a)
    .map(([gw, rows]) => ({ gw, rows }));
}

// ---- Main export ----

export interface HistoryCanvasProps {
  entries: HistoryEntry[];
  stats: AccuracyStats;
  currentGw: number | null;
}

export function HistoryCanvas({
  entries,
  stats,
  currentGw,
}: HistoryCanvasProps) {
  const [segment, setSegment] = useState<Segment>("all");
  const [gwFilter, setGwFilter] = useState<number | null>(null);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);

  const gws = useMemo(
    () => Array.from(new Set(entries.map((e) => e.gw))).sort((a, b) => b - a),
    [entries],
  );

  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        if (segment === "fpl" && !FPL_KINDS.has(e.kind)) return false;
        if (segment === "lms" && !LMS_KINDS.has(e.kind)) return false;
        if (gwFilter !== null && e.gw !== gwFilter) return false;
        if (pendingOnly && e.outcome !== null) return false;
        return true;
      }),
    [entries, segment, gwFilter, pendingOnly],
  );

  const grouped = useMemo(() => groupByGw(filtered), [filtered]);

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No recommendations yet"
        hint="Once the pipeline runs, each week's captain, LMS and transfer suggestions appear here with outcomes."
      />
    );
  }

  return (
    <>
      {/* Frame 1 — accuracy tally */}
      <AccuracyCard stats={stats} />

      {/* Filter bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedControl<Segment>
          aria-label="Category filter"
          options={[
            { label: "All", value: "all" },
            { label: "FPL", value: "fpl" },
            { label: "LMS", value: "lms" },
          ]}
          value={segment}
          onValueChange={(v) => {
            setSegment(v);
            setGwFilter(null);
          }}
          size="sm"
        />
        <Chip
          selected={pendingOnly}
          onClick={() => setPendingOnly((v) => !v)}
        >
          Pending only
        </Chip>
      </div>

      {/* GW chips */}
      {gws.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <Chip
            selected={gwFilter === null}
            onClick={() => setGwFilter(null)}
          >
            All GWs
          </Chip>
          {gws.map((gw) => (
            <Chip
              key={gw}
              selected={gwFilter === gw}
              onClick={() => setGwFilter((prev) => (prev === gw ? null : gw))}
            >
              GW {gw}
              {currentGw === gw && (
                <span
                  className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-accent"
                  aria-hidden
                />
              )}
            </Chip>
          ))}
        </div>
      )}

      {/* Frame 2 — mobile: GW-grouped cards */}
      <div className="md:hidden">
        {filtered.length === 0 ? (
          <EmptyState
            title="No results"
            hint="Try adjusting your filters."
          />
        ) : (
          <div className="space-y-1">
            {grouped.map(({ gw, rows }) => (
              <div key={gw}>
                <SectionTitle
                  right={
                    currentGw === gw ? (
                      <Badge tone="accent">Current</Badge>
                    ) : undefined
                  }
                >
                  GW {gw}
                </SectionTitle>
                <div className="space-y-2">
                  {rows.map((entry) => (
                    <RecRow
                      key={entry.id}
                      entry={entry}
                      onSelect={setSelected}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Frame 4 — desktop: wider table in centered column */}
      <div className="hidden md:block">
        {filtered.length === 0 ? (
          <EmptyState
            title="No results"
            hint="Try adjusting your filters."
          />
        ) : (
          <div className="overflow-x-auto">
            <Card padding="none">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-subtle">
                    {(["GW", "Type", "Recommendation", "Outcome"] as const).map(
                      (col) => (
                        <th
                          key={col}
                          className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted"
                        >
                          {col}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((entry) => (
                    <RecRow
                      key={entry.id}
                      entry={entry}
                      onSelect={setSelected}
                      desktop
                    />
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}
      </div>

      {/* Frame 3 — row detail BottomSheet */}
      <RecDetailSheet
        entry={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
