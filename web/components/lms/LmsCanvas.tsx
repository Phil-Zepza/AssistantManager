"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Minus,
  Pencil,
  Plus,
  Zap,
} from "lucide-react";
import {
  Badge,
  BottomSheet,
  Button,
  Callout,
  Card,
  ClubBadge,
  Countdown,
  EmptyState,
  Input,
  ProbBar,
  SegmentedControl,
  StatBlock,
  Toggle,
} from "@/components/ui";
import {
  computeForwardPlan,
  computeCompetitionPlan,
  computeDefaultDeadline,
  roundSkipStatus,
  type CompetitionPlan,
  type ForwardPlan,
  type PlannedPick,
  type PlannerCompetition,
  type PlannerPin,
  type PlannerFixtureProb,
  type PlannerTeam,
  type RoundSkipStatus,
  type SpreadPlannedPick,
  type SpreadSource,
} from "@/lib/lmsPlanner";
import {
  createCompetition,
  addEntry,
  submitPick,
  setStrategy,
  setReserves,
  setRoundDeadline,
  setSpreadMode,
  setSpreadOverride,
  setAutoSkipThreshold,
  skipRound,
  unskipRound,
} from "@/app/actions";
import { formatPct } from "@/lib/format";
import { useSetTopbarDeadline } from "@/components/shell/TopbarDeadlineContext";
import { deriveGwStatus, GW_STATUS_LABEL } from "@/lib/lmsStatus";
import type {
  LmsCompetitionDetail,
  LmsCompetitionSpreadView,
  LmsCompetitionSummary,
  LmsEntryDetail,
  LmsGameweekFixture,
  LmsGwStatus,
  LmsReserveStrategy,
  LmsSpreadMode,
  Team,
  TeamScouting,
} from "@/lib/types";
import type { ForwardPlanInputs } from "@/lib/queries";

// ─── Shared types (exported for page.tsx) ────────────────────────────────────

export type LmsEntryData = {
  detail: LmsEntryDetail;
  planInputs: ForwardPlanInputs | null;
};

export type LmsCompDetail = {
  competition: LmsCompetitionDetail;
  fixtures: LmsGameweekFixture[];
  entries: LmsEntryData[];
  teamStats: TeamScouting[];
  currentGw: number | null;
  firstEntryId: number;
  spreadView: LmsCompetitionSpreadView | null;
};

export interface LmsCanvasProps {
  competitions: LmsCompetitionSummary[];
  compDetail: LmsCompDetail | null;
  allTeams: Team[];
}

// ─── Local helpers ────────────────────────────────────────────────────────────

interface RankedPick {
  fixtureId: number;
  fixture: LmsGameweekFixture;
  team: Team;
  opponent: Team | null;
  pWin: number;
  pDraw: number | null;
  pLoss: number | null;
  isHome: boolean;
}

// The single backable side of one fixture: the higher-win% team that has not
// been used yet (falling back to the other side if the favourite is used).
// Returns null when neither side is backable (both used, or no model probs).
function pickFromFixture(
  f: LmsGameweekFixture,
  usedTeamIds: number[],
): RankedPick | null {
  const used = new Set(usedTeamIds);
  const pH = f.pHome;
  const pA = f.pAway;
  const homeOk = f.homeTeam != null && !used.has(f.homeTeam.fpl_id) && pH != null;
  const awayOk = f.awayTeam != null && !used.has(f.awayTeam.fpl_id) && pA != null;

  const homePick = (): RankedPick => ({
    fixtureId: f.fixtureId,
    fixture: f,
    team: f.homeTeam!,
    opponent: f.awayTeam,
    pWin: pH!,
    pDraw: f.pDraw,
    pLoss: pA ?? null,
    isHome: true,
  });
  const awayPick = (): RankedPick => ({
    fixtureId: f.fixtureId,
    fixture: f,
    team: f.awayTeam!,
    opponent: f.homeTeam,
    pWin: pA!,
    pDraw: f.pDraw,
    pLoss: pH ?? null,
    isHome: false,
  });

  if (homeOk && awayOk) return (pA as number) > (pH as number) ? awayPick() : homePick();
  if (homeOk) return homePick();
  if (awayOk) return awayPick();
  return null;
}

function getRankedPicks(
  fixtures: LmsGameweekFixture[],
  usedTeamIds: number[],
  n = 3,
): RankedPick[] {
  return fixtures
    .map((f) => pickFromFixture(f, usedTeamIds))
    .filter((p): p is RankedPick => p != null)
    .sort((a, b) => b.pWin - a.pWin)
    .slice(0, n);
}

function findCompetitionDeadline(
  competitions: LmsCompetitionSummary[],
  compId: number,
): { gw: number; deadline: string | null } | null {
  return competitions.find((c) => c.id === compId)?.nextDeadline ?? null;
}

// ─── Reserve-strategy copy (single source, reused across the add flows and the
//     competition strategy selector) ─────────────────────────────────────────

const RESERVE_STRATEGY_INFO: Record<
  LmsReserveStrategy,
  { label: string; blurb: string }
> = {
  safest: {
    label: "Safest",
    blurb:
      "Always allocate the highest available win% each qualifying round; never hold back.",
  },
  manual: {
    label: "Manual",
    blurb:
      "You nominate teams to reserve; the planner routes around them and prompts when a round has no safe non-reserved pick.",
  },
  smart: {
    label: "Smart",
    blurb:
      "Auto-reserves the top-4 elite teams for their strongest weeks and deploys them when nothing else clears your confidence floor (default 65%).",
  },
};

const STRATEGY_OPTIONS: { value: LmsReserveStrategy; label: string }[] = (
  ["safest", "manual", "smart"] as LmsReserveStrategy[]
).map((v) => ({ value: v, label: RESERVE_STRATEGY_INFO[v].label }));

/** Concise inline explanation of the currently-selected reserve strategy. */
function StrategyHelp({ mode }: { mode: LmsReserveStrategy }) {
  return (
    <p className="mt-1.5 text-xs leading-relaxed text-secondary">
      {RESERVE_STRATEGY_INFO[mode].blurb}
    </p>
  );
}

// ─── Live client clock (null until mounted → no hydration drift) ─────────────

function useNowMs(intervalMs = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ─── Scouting detail block (recent form · top scorers · xG) ──────────────────

const FORM_PIP: Record<"W" | "D" | "L", string> = {
  W: "bg-[rgba(22,225,163,0.16)] text-success",
  D: "bg-surface-2 text-muted",
  L: "bg-[rgba(244,63,94,0.14)] text-danger",
};

function FormPips({ form }: { form: ("W" | "D" | "L")[] }) {
  if (form.length === 0) {
    return <span className="text-[11px] text-muted">No games yet</span>;
  }
  return (
    <span className="flex items-center gap-1">
      {form.map((r, i) => (
        <span
          key={i}
          className={`grid h-4 w-4 place-items-center rounded text-[10px] font-bold ${FORM_PIP[r]}`}
          aria-hidden
        >
          {r}
        </span>
      ))}
      <span className="sr-only">Recent form: {form.join(", ")}</span>
    </span>
  );
}

/**
 * Always-on scouting glance for one team: recent form, top scorers and team
 * xG. Shows only current-season data once games have been played; before that,
 * renders a pending state instead of falling back to last-season numbers.
 * Data comes from player_season_stats / fixtures.
 *
 * NOTE: This reverses an earlier decision to fall back to labelled last-season
 * stats. The new rule: no current-season data → pending state, not last-season.
 */
function ScoutingDetail({
  scouting,
}: {
  scouting: TeamScouting | undefined;
}) {
  if (scouting == null) {
    return (
      <p className="text-[11px] text-muted">
        Detail appears after the next data run.
      </p>
    );
  }

  // No current-season data yet — show a clear pending state. We deliberately do
  // NOT fall back to last-season numbers (see getTeamScouting): stats auto-fill
  // once this season's games have been played.
  if (scouting.season !== "current") {
    return (
      <p className="text-[11px] text-muted">
        No current-season data yet — stats appear once games are played.
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      {/* Recent form */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Form
        </span>
        <FormPips form={scouting.form} />
      </div>

      <div className="flex items-start justify-between gap-4">
        {/* Top scorers */}
        <div className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted">
            Top scorers
          </span>
          {scouting.topScorers.length === 0 ? (
            <span className="text-xs text-muted">—</span>
          ) : (
            <ul className="mt-0.5 space-y-0.5">
              {scouting.topScorers.map((s) => (
                <li key={s.name} className="text-xs text-primary truncate">
                  <span className="font-semibold">{s.name}</span>{" "}
                  <span className="tnum text-secondary">{s.goals}⚽</span>
                  {s.xg != null && (
                    <span className="ml-1 tnum text-muted">
                      {s.xg.toFixed(1)} xG
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Team xG */}
        <div className="shrink-0 text-right">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted">
            Team xG
          </span>
          <span className="tnum text-lg font-bold text-primary">
            {scouting.xgFor != null ? scouting.xgFor.toFixed(1) : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Main canvas ──────────────────────────────────────────────────────────────

export function LmsCanvas({
  competitions,
  compDetail,
  allTeams,
}: LmsCanvasProps) {
  const router = useRouter();

  // Entry selection within a competition
  const [selectedEntryId, setSelectedEntryId] = useState(
    compDetail?.firstEntryId ?? 0,
  );

  // Forward-plan pins — client-only, never persisted
  const [pins, setPins] = useState<PlannerPin[]>([]);

  // Strategy overrides (optimistic until server confirms via refresh)
  const [strategyMode, setStrategyModeState] = useState<LmsReserveStrategy>("smart");
  const [floorPct, setFloorPct] = useState(65);
  const [reserveIds, setReserveIds] = useState<number[]>([]);
  const [strategySaving, setStrategySaving] = useState(false);

  // Competition-scoped spread mode (optimistic)
  const [spreadMode, setSpreadModeLocal] = useState<LmsSpreadMode>(
    compDetail?.competition.spreadMode ?? "off",
  );
  const [spreadSaving, setSpreadSaving] = useState(false);

  // Competition-scoped auto-skip threshold + manual skips (optimistic until the
  // server action lands via router.refresh). These drive a client-side plan
  // recompute so rounds cross the skip boundary live — nothing about future
  // rounds is persisted here beyond the skip config itself.
  const [autoSkipThreshold, setAutoSkipThresholdLocal] = useState<number | null>(
    compDetail?.competition.autoSkipUnderFixtures ?? null,
  );
  const [skippedRounds, setSkippedRoundsLocal] = useState<
    { gw: number; reason: string | null }[]
  >(compDetail ? [...compDetail.competition.skippedRounds] : []);
  const [autoSkipSaving, setAutoSkipSaving] = useState(false);
  const [skipSaving, setSkipSaving] = useState(false);

  // Modal / sheet states
  const [addCompOpen, setAddCompOpen] = useState(false);
  const [addEntryOpen, setAddEntryOpen] = useState(false);
  const [confirmPick, setConfirmPick] = useState<RankedPick | null>(null);
  const [deadlineOpen, setDeadlineOpen] = useState(false);
  const [overrideGw, setOverrideGw] = useState<number | null>(null);

  // Reset per-entry state when competition changes
  useEffect(() => {
    if (compDetail) {
      setSelectedEntryId(compDetail.firstEntryId);
      setPins([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compDetail?.competition.id]);

  // Sync spread mode from server when competition or its spread_mode changes
  useEffect(() => {
    if (compDetail) {
      setSpreadModeLocal(compDetail.competition.spreadMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compDetail?.competition.id, compDetail?.competition.spreadMode]);

  // Sync auto-skip threshold + manual skips from server (a router.refresh after
  // any skip action returns fresh arrays/values; reconcile optimistic state).
  useEffect(() => {
    if (compDetail) {
      setAutoSkipThresholdLocal(compDetail.competition.autoSkipUnderFixtures);
      setSkippedRoundsLocal([...compDetail.competition.skippedRounds]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    compDetail?.competition.id,
    compDetail?.competition.autoSkipUnderFixtures,
    compDetail?.competition.skippedRounds,
  ]);

  const selectedEntry =
    compDetail?.entries.find((e) => e.detail.id === selectedEntryId) ??
    compDetail?.entries[0] ??
    null;

  // Sync local strategy state when entry selection changes
  useEffect(() => {
    if (selectedEntry) {
      setStrategyModeState(selectedEntry.detail.strategy);
      setFloorPct(Math.round(selectedEntry.detail.confidenceFloor * 100));
      setReserveIds([...selectedEntry.detail.reservedTeamIds]);
      setPins([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntry?.detail.id]);

  // Forward plan: pure recompute on every local override
  const planInputs = selectedEntry?.planInputs ?? null;

  // Overlay the optimistic skip config onto the planner competition so a
  // skip/unskip or threshold change recomputes the horizon client-side.
  const effectiveCompetition = useMemo<PlannerCompetition | null>(() => {
    if (!planInputs) return null;
    return {
      ...planInputs.competition,
      autoSkipUnderFixtures: autoSkipThreshold,
      skippedRounds,
    };
  }, [planInputs, autoSkipThreshold, skippedRounds]);

  const plan = useMemo((): ForwardPlan | null => {
    if (!planInputs || !effectiveCompetition) return null;
    return computeForwardPlan({
      ...planInputs,
      competition: effectiveCompetition,
      entryState: {
        ...planInputs.entryState,
        strategy: strategyMode,
        confidenceFloor: floorPct / 100,
        reservedTeamIds: strategyMode === "manual" ? reserveIds : [],
      },
      pins,
    });
  }, [planInputs, effectiveCompetition, strategyMode, floorPct, reserveIds, pins]);

  // Cross-entry competition plan — only when ≥2 alive entries
  const competitionPlan = useMemo((): CompetitionPlan | null => {
    if (!planInputs || !effectiveCompetition || planInputs.aliveEntries.length < 2)
      return null;
    return computeCompetitionPlan({
      entries: planInputs.aliveEntries.map((e) => ({
        ...e,
        pins: e.entryId === selectedEntryId ? pins : undefined,
      })),
      upcomingRounds: planInputs.upcomingRounds,
      fixtureProbs: planInputs.fixtureProbs,
      teams: planInputs.teams,
      eliteSet: planInputs.eliteSet,
      spreadMode: spreadMode as "off" | "soft" | "strong",
      spreadFloorSoft: compDetail?.competition.spreadFloorSoft ?? 0.65,
      overrides: planInputs.spreadOverrides,
      competition: effectiveCompetition,
    });
  }, [planInputs, effectiveCompetition, selectedEntryId, pins, spreadMode, compDetail?.competition.spreadFloorSoft]);

  // Spread picks for the currently selected entry from the competition plan
  const selectedSpreadPicks = competitionPlan?.entries
    .find((e) => e.entryId === selectedEntryId)?.picks ?? null;

  const usedTeamIds = selectedEntry?.detail.usedTeamIds ?? [];

  // Skip status for the round currently open in the override sheet — drives
  // whether that sheet shows the pick list + "Skip this round", the manual-skip
  // panel (edit/restore), or the read-only auto-skip explainer.
  const overrideRound =
    overrideGw != null
      ? planInputs?.upcomingRounds.find((r) => r.gw === overrideGw) ?? null
      : null;
  const overrideSkipStatus: RoundSkipStatus | null =
    overrideRound && effectiveCompetition
      ? roundSkipStatus(overrideRound, effectiveCompetition)
      : null;
  const overrideManualReason =
    overrideGw != null
      ? skippedRounds.find((s) => s.gw === overrideGw)?.reason ?? null
      : null;

  const rankedPicks = useMemo(
    () => getRankedPicks(compDetail?.fixtures ?? [], usedTeamIds),
    [compDetail?.fixtures, usedTeamIds],
  );

  const teamStatsById = useMemo(
    () => new Map((compDetail?.teamStats ?? []).map((s) => [s.teamId, s])),
    [compDetail?.teamStats],
  );

  const currentGw = compDetail?.currentGw ?? null;
  const nowMs = useNowMs();

  // ── Strategy handlers ──────────────────────────────────────────────────────

  async function handleStrategyChange(mode: LmsReserveStrategy) {
    setStrategyModeState(mode);
    if (!selectedEntry) return;
    setStrategySaving(true);
    try {
      await setStrategy(selectedEntry.detail.id, mode, floorPct / 100);
      router.refresh();
    } finally {
      setStrategySaving(false);
    }
  }

  async function handleFloorCommit(pct: number) {
    setFloorPct(pct);
    if (!selectedEntry || strategyMode === "safest") return;
    setStrategySaving(true);
    try {
      await setStrategy(selectedEntry.detail.id, strategyMode, pct / 100);
      router.refresh();
    } finally {
      setStrategySaving(false);
    }
  }

  async function handleReserveToggle(teamId: number) {
    if (!selectedEntry) return;
    const next = reserveIds.includes(teamId)
      ? reserveIds.filter((id) => id !== teamId)
      : [...reserveIds, teamId];
    setReserveIds(next);
    await setReserves(selectedEntry.detail.id, next);
    router.refresh();
  }

  // ── Spread handlers ───────────────────────────────────────────────────────

  async function handleSpreadMode(mode: LmsSpreadMode) {
    if (!compDetail) return;
    setSpreadModeLocal(mode);
    setSpreadSaving(true);
    try {
      await setSpreadMode(compDetail.competition.id, mode);
      router.refresh();
    } finally {
      setSpreadSaving(false);
    }
  }

  async function handleSpreadOverride(gw: number, forceSame: boolean) {
    if (!compDetail) return;
    await setSpreadOverride(compDetail.competition.id, gw, forceSame);
    router.refresh();
  }

  // ── Skip handlers (competition-scoped) ─────────────────────────────────────

  async function handleAutoSkipThreshold(n: number | null) {
    if (!compDetail) return;
    setAutoSkipThresholdLocal(n);
    setAutoSkipSaving(true);
    try {
      await setAutoSkipThreshold(compDetail.competition.id, n);
      router.refresh();
    } finally {
      setAutoSkipSaving(false);
    }
  }

  async function handleSkipRound(gw: number, reason?: string) {
    if (!compDetail) return;
    const trimmed = reason?.trim();
    const value = trimmed && trimmed.length > 0 ? trimmed : null;
    setSkippedRoundsLocal((prev) => [
      ...prev.filter((s) => s.gw !== gw),
      { gw, reason: value },
    ]);
    setOverrideGw(null);
    setSkipSaving(true);
    try {
      await skipRound(compDetail.competition.id, gw, reason);
      router.refresh();
    } finally {
      setSkipSaving(false);
    }
  }

  async function handleUnskipRound(gw: number) {
    if (!compDetail) return;
    setSkippedRoundsLocal((prev) => prev.filter((s) => s.gw !== gw));
    setOverrideGw(null);
    setSkipSaving(true);
    try {
      await unskipRound(compDetail.competition.id, gw);
      router.refresh();
    } finally {
      setSkipSaving(false);
    }
  }

  // ── Pin override handlers ──────────────────────────────────────────────────

  function handlePinSelect(gw: number, teamId: number) {
    setPins((prev) => [...prev.filter((p) => p.gw !== gw), { gw, teamId }]);
    setOverrideGw(null);
  }

  function handleClearPin(gw: number) {
    setPins((prev) => prev.filter((p) => p.gw !== gw));
  }

  // Publish this competition's effective round deadline (override else default)
  // to the top app bar so its countdown matches the status header below. Cleared
  // (→ layout default) whenever no competition is open. Called unconditionally,
  // before the lobby early-return, to respect the Rules of Hooks.
  const topbarDeadline = compDetail
    ? findCompetitionDeadline(competitions, compDetail.competition.id)
    : null;
  useSetTopbarDeadline(
    topbarDeadline?.deadline ?? null,
    topbarDeadline?.gw ?? null,
    compDetail != null,
  );

  // ── Lobby ──────────────────────────────────────────────────────────────────

  if (!compDetail) {
    return (
      <div className="pb-24 md:pb-8">
        <LobbyScreen
          competitions={competitions}
          onNavigate={(id) => router.push(`/lms?comp=${id}`)}
          onAddComp={() => setAddCompOpen(true)}
        />
        <AddCompSheet
          open={addCompOpen}
          onClose={() => setAddCompOpen(false)}
          allTeams={allTeams}
          onCreated={(id) => {
            setAddCompOpen(false);
            router.push(`/lms?comp=${id}`);
          }}
        />
      </div>
    );
  }

  // ── Competition view ────────────────────────────────────────────────────────

  const isEliminated = selectedEntry?.detail.status === "out";
  const nextDeadline = findCompetitionDeadline(
    competitions,
    compDetail.competition.id,
  );

  const gwStatus: LmsGwStatus =
    nowMs == null
      ? "unknown"
      : deriveGwStatus({
          deadline: nextDeadline?.deadline ?? null,
          fixtures: compDetail.fixtures,
          nowMs,
        });

  const alreadyLocked = !!selectedEntry?.detail.picks.some(
    (p) => p.gw === currentGw,
  );
  // Picks are writable while the round is open (before the deadline). "unknown"
  // (pre-mount / no fixture data) stays lenient so controls don't flash out.
  const canPick =
    !alreadyLocked && (gwStatus === "open" || gwStatus === "unknown");

  return (
    <div className="pb-24 md:pb-8">
      {/* Back + entry switcher */}
      <EntryHeader
        competition={compDetail.competition}
        entries={compDetail.entries}
        selectedEntryId={selectedEntryId}
        onSelectEntry={(id) => setSelectedEntryId(id)}
        onAddEntry={() => setAddEntryOpen(true)}
        currentGw={currentGw}
        gwStatus={gwStatus}
        usedCount={usedTeamIds.length}
        remainingCount={
          (selectedEntry?.detail.teams.filter((t) => !t.used).length ?? 0)
        }
        nextDeadline={nextDeadline}
        onDeadlineClick={() => setDeadlineOpen(true)}
        onBack={() => router.push("/lms")}
      />

      {isEliminated && selectedEntry ? (
        <EliminatedView
          entry={selectedEntry.detail}
          allEntries={compDetail.entries}
          onSwitchEntry={(id) => setSelectedEntryId(id)}
          onAddEntry={() => setAddEntryOpen(true)}
        />
      ) : (
        <>
          <FixturesSection
            fixtures={compDetail.fixtures}
            currentGw={currentGw}
            usedTeamIds={usedTeamIds}
            teamStatsById={teamStatsById}
            canPick={canPick}
            onBackPick={(pick) => setConfirmPick(pick)}
          />

          <Top3Section
            currentGw={currentGw}
            rankedPicks={rankedPicks}
            teamStatsById={teamStatsById}
            canPick={canPick}
            spreadView={compDetail.spreadView}
            selectedEntryId={selectedEntryId}
            onBackPick={(pick) => setConfirmPick(pick)}
          />

          {plan && (
            <ForwardPlanSection
              plan={plan}
              spreadPicks={selectedSpreadPicks}
              planInputs={planInputs!}
              pins={pins}
              usedTeamIds={usedTeamIds}
              currentGw={currentGw}
              spreadMode={spreadMode}
              spreadFloorSoft={compDetail.competition.spreadFloorSoft}
              autoCollapsedGws={competitionPlan?.autoCollapsedGws ?? []}
              skippedRounds={skippedRounds}
              onTileClick={(gw) => setOverrideGw(gw)}
              onClearPin={handleClearPin}
              onSpreadOverride={handleSpreadOverride}
            />
          )}

          {plan && planInputs && (
            <SummarySection
              picks={selectedSpreadPicks ?? plan.picks}
              teams={planInputs.teams}
            />
          )}

          {selectedEntry && (
            <StrategySection
              entry={selectedEntry.detail}
              strategyMode={strategyMode}
              floorPct={floorPct}
              reserveIds={reserveIds}
              saving={strategySaving}
              spreadMode={spreadMode}
              spreadSaving={spreadSaving}
              totalEntryCount={compDetail.competition.entries.length}
              autoSkipThreshold={autoSkipThreshold}
              autoSkipSaving={autoSkipSaving}
              onStrategyChange={handleStrategyChange}
              onFloorChange={setFloorPct}
              onFloorCommit={handleFloorCommit}
              onReserveToggle={handleReserveToggle}
              onSpreadModeChange={handleSpreadMode}
              onAutoSkipChange={handleAutoSkipThreshold}
              onAddEntry={() => setAddEntryOpen(true)}
            />
          )}

          {selectedEntry && (
            <UsedRemainingSection entry={selectedEntry.detail} />
          )}
        </>
      )}

      {/* Sheets */}
      <AddEntrySheet
        open={addEntryOpen}
        onClose={() => setAddEntryOpen(false)}
        competitionId={compDetail.competition.id}
        willAutoSoft={
          compDetail.competition.entries.length === 1 && spreadMode === "off"
        }
        onAdded={() => {
          setAddEntryOpen(false);
          router.refresh();
        }}
      />

      <SubmitConfirmSheet
        pick={confirmPick}
        currentGw={currentGw}
        entryId={selectedEntry?.detail.id ?? null}
        onClose={() => setConfirmPick(null)}
        onSubmitted={() => {
          setConfirmPick(null);
          router.refresh();
        }}
      />

      <DeadlineOverrideSheet
        open={deadlineOpen}
        onClose={() => setDeadlineOpen(false)}
        competitionId={compDetail.competition.id}
        currentGw={currentGw}
        fixtures={compDetail.fixtures}
        onSaved={() => {
          setDeadlineOpen(false);
          router.refresh();
        }}
      />

      {planInputs && (
        <PinPickerSheet
          gw={overrideGw}
          onClose={() => setOverrideGw(null)}
          fixtureProbs={planInputs.fixtureProbs}
          teams={planInputs.teams}
          excludedTeamIds={[
            ...planInputs.entryState.usedTeamIds,
            ...pins
              .filter((p) => p.gw !== overrideGw)
              .map((p) => p.teamId),
          ]}
          onSelect={handlePinSelect}
          skipStatus={overrideSkipStatus}
          manualReason={overrideManualReason}
          skipSaving={skipSaving}
          onSkip={handleSkipRound}
          onUnskip={handleUnskipRound}
          spreadActive={
            spreadMode !== "off" && planInputs.aliveEntries.length >= 2
          }
        />
      )}
    </div>
  );
}

// ─── Screen: Lobby ────────────────────────────────────────────────────────────

function LobbyScreen({
  competitions,
  onNavigate,
  onAddComp,
}: {
  competitions: LmsCompetitionSummary[];
  onNavigate: (compId: number) => void;
  onAddComp: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Your competitions
        </h2>
        <Button size="sm" icon={<Plus />} onClick={onAddComp}>
          Add Competition
        </Button>
      </div>

      {competitions.length === 0 ? (
        <EmptyState
          title="No competitions yet"
          description="Add a Last Man Standing competition to start tracking your entries."
          action={
            <Button icon={<Plus />} onClick={onAddComp}>
              Add Competition
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {competitions.map((comp) => (
            <button
              key={comp.id}
              type="button"
              onClick={() => onNavigate(comp.id)}
              className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"
            >
              <Card className="hover:border-strong transition-colors duration-micro">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-primary truncate">
                        {comp.name}
                      </p>
                      {comp.nextDeadline && (
                        <Badge tone="gray">GW{comp.nextDeadline.gw}</Badge>
                      )}
                    </div>

                    {/* Per-entry alive/out dots */}
                    {comp.entries.length > 0 && (
                      <div className="mt-2 flex items-center gap-2 flex-wrap">
                        {comp.entries.map((e) => (
                          <span
                            key={e.id}
                            className="flex items-center gap-1.5 text-xs text-secondary"
                          >
                            <span
                              className={`h-2 w-2 rounded-full ${
                                e.status === "out"
                                  ? "bg-danger"
                                  : "bg-success"
                              }`}
                              aria-hidden
                            />
                            {e.label}
                          </span>
                        ))}
                      </div>
                    )}

                    {comp.nextDeadline?.deadline && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-secondary">
                        <Clock className="h-3.5 w-3.5 text-muted" aria-hidden />
                        <Countdown
                          deadline={comp.nextDeadline.deadline}
                          className="text-xs"
                          prefix="Deadline: "
                        />
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5">
                      {comp.aliveCount > 0 && (
                        <Badge tone="success">{comp.aliveCount} alive</Badge>
                      )}
                      {comp.outCount > 0 && (
                        <Badge tone="danger">{comp.outCount} out</Badge>
                      )}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted" aria-hidden />
                  </div>
                </div>
              </Card>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Competition: entry header ─────────────────────────────────────────────────

const GW_STATUS_TONE: Record<
  LmsGwStatus,
  "success" | "accent" | "warning" | "gray"
> = {
  open: "success",
  starting_soon: "warning",
  in_progress: "accent",
  complete: "gray",
  unknown: "gray",
};

function EntryHeader({
  competition,
  entries,
  selectedEntryId,
  onSelectEntry,
  onAddEntry,
  currentGw,
  gwStatus,
  usedCount,
  remainingCount,
  nextDeadline,
  onDeadlineClick,
  onBack,
}: {
  competition: LmsCompetitionDetail;
  entries: LmsEntryData[];
  selectedEntryId: number;
  onSelectEntry: (id: number) => void;
  onAddEntry: () => void;
  currentGw: number | null;
  gwStatus: LmsGwStatus;
  usedCount: number;
  remainingCount: number;
  nextDeadline: { gw: number; deadline: string | null } | null;
  onDeadlineClick: () => void;
  onBack: () => void;
}) {
  const selectedEntry = entries.find((e) => e.detail.id === selectedEntryId);
  const isAlive = selectedEntry?.detail.status !== "out";

  const entryOptions = entries.map((e) => ({
    value: String(e.detail.id),
    label: (
      <span className="flex items-center gap-1.5">
        {e.detail.status === "out" && (
          <span className="h-2 w-2 rounded-full bg-danger" aria-hidden />
        )}
        {e.detail.label}
      </span>
    ),
  }));

  return (
    <div className="mb-5 space-y-3">
      {/* Back + competition name */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
          aria-label="Back to lobby"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Lobby
        </button>
        <span className="text-secondary">/</span>
        <p className="truncate text-sm font-semibold text-primary">
          {competition.name}
        </p>
      </div>

      {/* Entry switcher */}
      <div className="flex items-center gap-2 flex-wrap">
        {entries.length > 1 ? (
          <SegmentedControl
            aria-label="Entry"
            options={entryOptions}
            value={String(selectedEntryId)}
            onValueChange={(v) => onSelectEntry(Number(v))}
          />
        ) : (
          <span className="text-sm font-semibold text-primary">
            {selectedEntry?.detail.label ?? "Entry"}
          </span>
        )}
        <button
          type="button"
          onClick={onAddEntry}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-subtle bg-surface text-secondary hover:text-primary hover:border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Add new entry"
        >
          <Plus className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {/* Status summary */}
      <Card padding="sm">
        <div className="flex items-center gap-3 flex-wrap">
          {currentGw != null && (
            <Badge tone="gray" className="shrink-0">
              GW{currentGw}
            </Badge>
          )}

          <Badge tone={isAlive ? "success" : "danger"} className="shrink-0">
            {isAlive ? "Alive" : "Out"}
          </Badge>

          {/* Round lifecycle status */}
          {gwStatus !== "unknown" && (
            <Badge tone={GW_STATUS_TONE[gwStatus]} className="shrink-0">
              {GW_STATUS_LABEL[gwStatus]}
            </Badge>
          )}

          {/* Deadline: a live countdown while the round is still open, else a
              short static note reflecting where the round is. */}
          {nextDeadline?.deadline && gwStatus === "open" ? (
            <button
              type="button"
              onClick={onDeadlineClick}
              className="flex items-center gap-1 text-xs text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
              title="Edit deadline"
            >
              <Clock className="h-3.5 w-3.5" aria-hidden />
              <Countdown
                deadline={nextDeadline.deadline}
                className="text-xs"
                passedLabel="Deadline passed"
              />
            </button>
          ) : (
            gwStatus !== "unknown" && (
              <button
                type="button"
                onClick={onDeadlineClick}
                className="flex items-center gap-1 text-xs text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
                title="Edit deadline"
              >
                <Clock className="h-3.5 w-3.5" aria-hidden />
                {gwStatus === "starting_soon"
                  ? "Deadline passed · kicking off soon"
                  : gwStatus === "in_progress"
                    ? "Round in progress"
                    : "Round complete"}
              </button>
            )
          )}

          <span className="ml-auto text-xs font-medium text-secondary shrink-0">
            {usedCount} used · {remainingCount} remaining
          </span>
        </div>
      </Card>
    </div>
  );
}

// ─── Competition: fixtures section ────────────────────────────────────────────

function FixturesSection({
  fixtures,
  currentGw,
  usedTeamIds,
  teamStatsById,
  canPick,
  onBackPick,
}: {
  fixtures: LmsGameweekFixture[];
  currentGw: number | null;
  usedTeamIds: number[];
  teamStatsById: Map<number, TeamScouting>;
  canPick: boolean;
  onBackPick: (pick: RankedPick) => void;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <section className="mt-2 mb-5">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
        GW{currentGw ?? "?"} fixtures
      </h2>

      {fixtures.length === 0 ? (
        <Card>
          <p className="text-sm text-secondary">
            No fixtures loaded for this round yet.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {fixtures.map((f) => (
            <FixtureRow
              key={f.fixtureId}
              fixture={f}
              usedTeamIds={usedTeamIds}
              teamStatsById={teamStatsById}
              canPick={canPick}
              expanded={expandedId === f.fixtureId}
              onToggle={() =>
                setExpandedId((prev) =>
                  prev === f.fixtureId ? null : f.fixtureId,
                )
              }
              onBackPick={onBackPick}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function FixtureRow({
  fixture: f,
  usedTeamIds,
  teamStatsById,
  canPick,
  expanded,
  onToggle,
  onBackPick,
}: {
  fixture: LmsGameweekFixture;
  usedTeamIds: number[];
  teamStatsById: Map<number, TeamScouting>;
  canPick: boolean;
  expanded: boolean;
  onToggle: () => void;
  onBackPick: (pick: RankedPick) => void;
}) {
  const used = new Set(usedTeamIds);
  const homeUsed = f.homeTeam != null && used.has(f.homeTeam.fpl_id);
  const awayUsed = f.awayTeam != null && used.has(f.awayTeam.fpl_id);

  // Backable side of this fixture (favoured available team; null if none).
  const pick = pickFromFixture(f, usedTeamIds);

  // Market-unavailable flag: no book has priced this fixture (usually a future
  // round), so the shown p_* is the model estimate rather than the market.
  const marketUnavailable =
    f.marketAvailable === false && (f.pHome != null || f.pAway != null);

  return (
    <Card padding="sm">
      <div className="flex items-center gap-2">
        {/* Expand toggle wraps the fixture summary */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex flex-1 items-center gap-3 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          {/* Home side */}
          <div
            className={`flex items-center gap-2 flex-1 min-w-0 ${homeUsed ? "opacity-40" : ""}`}
          >
            <ClubBadge
              code={f.homeTeam?.short_name}
              size={32}
              state={homeUsed ? "used" : "default"}
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-primary truncate">
                {f.homeTeam?.short_name ?? "?"}
              </p>
              {f.pHome != null && (
                <p className="text-xs font-bold tnum text-accent">
                  {formatPct(f.pHome)}
                </p>
              )}
            </div>
          </div>

          {/* Prob bar + vs */}
          <div className="w-24 shrink-0">
            <ProbBar home={f.pHome} draw={f.pDraw} away={f.pAway} />
            <p className="mt-0.5 text-center text-[11px] text-muted">
              {f.pDraw != null ? `D ${formatPct(f.pDraw)}` : "vs"}
            </p>
          </div>

          {/* Away side */}
          <div
            className={`flex items-center gap-2 flex-1 min-w-0 justify-end ${awayUsed ? "opacity-40" : ""}`}
          >
            <div className="min-w-0 text-right">
              <p className="text-sm font-semibold text-primary truncate">
                {f.awayTeam?.short_name ?? "?"}
              </p>
              {f.pAway != null && (
                <p className="text-xs font-bold tnum text-accent">
                  {formatPct(f.pAway)}
                </p>
              )}
            </div>
            <ClubBadge
              code={f.awayTeam?.short_name}
              size={32}
              state={awayUsed ? "used" : "default"}
            />
          </div>

          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted transition-transform duration-micro ${expanded ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>

        {/* Back control — any fixture is backable (favoured available side) */}
        {canPick && pick && (
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0"
            onClick={() => onBackPick(pick)}
          >
            Back {pick.team.short_name}
          </Button>
        )}
      </div>

      {marketUnavailable && (
        <div className="mt-2 flex justify-center">
          <Badge tone="gray">Market unavailable — model estimate</Badge>
        </div>
      )}

      {expanded && (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-subtle pt-3 sm:grid-cols-2">
          <FixtureTeamDetail
            team={f.homeTeam}
            venue="H"
            scouting={
              f.homeTeam ? teamStatsById.get(f.homeTeam.fpl_id) : undefined
            }
          />
          <FixtureTeamDetail
            team={f.awayTeam}
            venue="A"
            scouting={
              f.awayTeam ? teamStatsById.get(f.awayTeam.fpl_id) : undefined
            }
          />
        </div>
      )}
    </Card>
  );
}

// One team's header (badge + name + venue) above its scouting detail. Used in
// the expandable fixture rows so both sides are shown side by side.
function FixtureTeamDetail({
  team,
  venue,
  scouting,
}: {
  team: Team | null;
  venue: "H" | "A";
  scouting: TeamScouting | undefined;
}) {
  return (
    <div className="rounded-lg bg-surface-2 p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <ClubBadge code={team?.short_name} size={24} />
        <span className="truncate text-xs font-semibold text-primary">
          {team?.short_name ?? "?"}{" "}
          <span className="font-normal text-muted">({venue})</span>
        </span>
      </div>
      <ScoutingDetail scouting={scouting} />
    </div>
  );
}

// ─── Competition: top-3 picks ─────────────────────────────────────────────────

function Top3Section({
  currentGw,
  rankedPicks,
  teamStatsById,
  canPick,
  spreadView,
  selectedEntryId,
  onBackPick,
}: {
  currentGw: number | null;
  rankedPicks: RankedPick[];
  teamStatsById: Map<number, TeamScouting>;
  canPick: boolean;
  spreadView: LmsCompetitionSpreadView | null;
  selectedEntryId: number;
  onBackPick: (pick: RankedPick) => void;
}) {
  // Siblings: alive entries other than the currently selected one
  const siblings =
    spreadView != null
      ? spreadView.entries.filter(
          (e) => e.entryId !== selectedEntryId && e.status === "alive",
        )
      : [];

  // Team ids held by any sibling this round (chosen > planned priority)
  const siblingTeamIds = new Set(
    siblings
      .map((e) => (e.chosenTeam ?? e.plannedTeam)?.fpl_id)
      .filter((id): id is number => id != null),
  );

  const topPickTeamId = rankedPicks[0]?.team.fpl_id;
  const topPickDuplicatesSibling =
    topPickTeamId != null && siblingTeamIds.has(topPickTeamId);

  // Which sibling holds the top pick?
  const siblingWithTopPick = topPickDuplicatesSibling
    ? siblings.find(
        (e) =>
          (e.chosenTeam?.fpl_id ?? e.plannedTeam?.fpl_id) === topPickTeamId,
      )
    : null;

  // First ranked pick not held by any sibling (clean alternative)
  const cleanAlternative =
    topPickDuplicatesSibling
      ? rankedPicks.slice(1).find((p) => !siblingTeamIds.has(p.team.fpl_id))
      : null;

  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
        Top 3 picks{currentGw != null ? ` · GW${currentGw}` : ""}
      </h2>

      {rankedPicks.length === 0 ? (
        <Card>
          <p className="text-sm text-secondary">
            No ranked options yet — win probabilities appear once the model has
            run.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {rankedPicks.map((pick, i) => (
            <PickCard
              key={pick.fixtureId}
              pick={pick}
              rank={i + 1}
              canPick={canPick}
              scouting={teamStatsById.get(pick.team.fpl_id)}
              isCleanAlternative={cleanAlternative?.fixtureId === pick.fixtureId}
              onBackPick={onBackPick}
            />
          ))}
        </div>
      )}

      {/* Awareness row — show whenever ≥2 alive entries exist, any spread_mode */}
      {siblings.length > 0 && (
        <div className="mt-3 space-y-2">
          {topPickDuplicatesSibling && (
            <Callout tone="danger">
              Your top pick duplicates{" "}
              {siblingWithTopPick ? siblingWithTopPick.label : "another entry"} —
              one slip-up takes out both lives; consider your #2
              {cleanAlternative && (
                <span className="block mt-1 text-xs">
                  ✓ No other entry on this: {cleanAlternative.team.short_name}
                </span>
              )}
            </Callout>
          )}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-subtle bg-surface-2 px-3 py-2">
            <span className="text-xs font-medium text-muted shrink-0">
              Also this round · your other entries
            </span>
            {siblings.map((e) => {
              const team = e.chosenTeam ?? e.plannedTeam;
              const isDuplicate =
                team != null && siblingTeamIds.size > 0
                  ? spreadView?.duplicateTeamIds.includes(team.fpl_id) ?? false
                  : false;
              return (
                <span
                  key={e.entryId}
                  className="flex items-center gap-1.5 text-xs"
                >
                  <span className="text-secondary">{e.label}</span>
                  <span className="text-muted">→</span>
                  {team ? (
                    <>
                      <ClubBadge
                        code={team.short_name}
                        size={24}
                        ring={isDuplicate ? "var(--danger)" : undefined}
                      />
                      <span
                        className={
                          isDuplicate ? "font-semibold text-danger" : "text-primary"
                        }
                      >
                        {team.short_name}
                        {e.chosenTeam != null && (
                          <span className="ml-0.5 text-[10px] text-muted">
                            {" "}locked
                          </span>
                        )}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function PickCard({
  pick,
  rank,
  canPick,
  scouting,
  isCleanAlternative,
  onBackPick,
}: {
  pick: RankedPick;
  rank: number;
  canPick: boolean;
  scouting: TeamScouting | undefined;
  isCleanAlternative?: boolean;
  onBackPick: (pick: RankedPick) => void;
}) {
  const venue = pick.isHome ? "H" : "A";

  if (rank === 1) {
    return (
      <Card selected>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-3">
            <ClubBadge code={pick.team.short_name} size={64} state="recommended" />
            <span className="text-xl font-bold text-muted">v</span>
            <ClubBadge code={pick.opponent?.short_name} size={44} />
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge tone="accent">#1 · Safest banker</Badge>
            {isCleanAlternative && (
              <Badge tone="success">✓ No other entry on this</Badge>
            )}
          </div>
        </div>

        <div className="flex items-end justify-between gap-3 mb-3">
          <div>
            <p className="text-2xl font-bold text-primary">
              {pick.team.name}{" "}
              <span className="text-base font-medium text-secondary">({venue})</span>
            </p>
            <p className="mt-0.5 text-sm text-secondary">
              v {pick.opponent?.name ?? "TBD"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-4xl font-black leading-none tnum text-accent">
              {formatPct(pick.pWin)}
            </p>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              outright win
            </p>
          </div>
        </div>

        <ProbBar home={pick.pWin} draw={pick.pDraw} away={pick.pLoss} showLabels />

        {/* Full detail always shown on pick cards */}
        <div className="mt-3 border-t border-subtle pt-3">
          <ScoutingDetail scouting={scouting} />
        </div>

        {canPick && (
          <Button className="mt-3 w-full" onClick={() => onBackPick(pick)}>
            Back this pick
          </Button>
        )}
      </Card>
    );
  }

  return (
    <Card padding="sm">
      <div className="flex items-center gap-3">
        <span className="w-5 shrink-0 text-center text-sm font-bold text-muted">
          {rank}
        </span>
        <ClubBadge code={pick.team.short_name} size={32} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-primary">
            {pick.team.name}{" "}
            <span className="font-medium text-secondary">({venue})</span>{" "}
            <span className="text-xs text-muted">
              v {pick.opponent?.short_name ?? "TBD"}
            </span>
          </p>
        </div>
        <span className="shrink-0 text-right">
          <span className="block text-base font-bold tnum text-accent">
            {formatPct(pick.pWin)}
          </span>
          <span className="text-[11px] text-muted">win</span>
        </span>
        {isCleanAlternative && (
          <Badge tone="success">✓ No other entry</Badge>
        )}
        {canPick && (
          <Button size="sm" variant="secondary" onClick={() => onBackPick(pick)}>
            Back
          </Button>
        )}
      </div>

      {/* Full detail always shown on pick cards */}
      <div className="mt-2.5 border-t border-subtle pt-2.5">
        <ScoutingDetail scouting={scouting} />
      </div>
    </Card>
  );
}

// ─── Competition: forward plan ────────────────────────────────────────────────

// Derive a spread marker for a tile from its spread pick
function getSpreadMarker(
  spreadPick: SpreadPlannedPick | undefined,
  spreadMode: LmsSpreadMode,
): "matched" | "spread" | "belowFloor" | undefined {
  if (!spreadPick) return undefined;
  if (spreadPick.spreadSource === "matched") return "matched";
  if (spreadPick.spreadSource === "spread") {
    if (spreadMode === "strong" && spreadPick.flags.includes("needsDeploy")) {
      return "belowFloor";
    }
    return "spread";
  }
  return undefined;
}

function ForwardPlanSection({
  plan,
  spreadPicks,
  planInputs,
  pins,
  usedTeamIds,
  currentGw,
  spreadMode,
  spreadFloorSoft,
  autoCollapsedGws,
  skippedRounds,
  onTileClick,
  onClearPin,
  onSpreadOverride,
}: {
  plan: ForwardPlan;
  spreadPicks: SpreadPlannedPick[] | null;
  planInputs: ForwardPlanInputs;
  pins: PlannerPin[];
  usedTeamIds: number[];
  currentGw: number | null;
  spreadMode: LmsSpreadMode;
  spreadFloorSoft: number;
  autoCollapsedGws: number[];
  skippedRounds: { gw: number; reason: string | null }[];
  onTileClick: (gw: number) => void;
  onClearPin: (gw: number) => void;
  onSpreadOverride: (gw: number, forceSame: boolean) => void;
}) {
  const teamById = new Map(planInputs.teams.map((t) => [t.id, t]));

  // Per-round fixture counts (for the auto-skip "N games" caption) and manual
  // skip reasons (to tell "has reason" from the planner's default reason text).
  const numFixturesByGw = new Map(
    planInputs.upcomingRounds.map((r) => [r.gw, r.numFixtures]),
  );
  const manualReasonByGw = new Map(
    skippedRounds.map((s) => [s.gw, s.reason]),
  );

  // When we have a competition plan, use its picks (may pick different teams)
  const picks: PlannedPick[] = spreadPicks ?? plan.picks;
  const spreadPicksByGw = new Map(spreadPicks?.map((p) => [p.gw, p]) ?? []);

  // Per-round override state for current GW
  const isAutoCollapsed =
    currentGw != null && autoCollapsedGws.includes(currentGw);
  const isManualOverride =
    currentGw != null &&
    planInputs.spreadOverrides.some(
      (o) => o.gw === currentGw && o.forceSame,
    );
  const forceSame = isAutoCollapsed || isManualOverride;
  const showOverrideControl =
    currentGw != null && spreadPicks != null; // ≥2 alive entries

  return (
    <section className="mb-5">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Forward plan
        </h2>
        <span className="text-xs text-muted">
          tap a round to override · not saved
        </span>
      </div>

      {showOverrideControl && (
        <div className="mb-2 flex items-center justify-between rounded-lg border border-subtle bg-surface-2 px-3 py-2">
          <span className="text-xs font-medium text-secondary">
            Use same team across entries · GW{currentGw}
          </span>
          {isAutoCollapsed ? (
            <Badge tone="gray">Auto (only one team cleared floor)</Badge>
          ) : (
            <button
              type="button"
              onClick={() =>
                currentGw != null && onSpreadOverride(currentGw, !forceSame)
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                forceSame
                  ? "bg-accent"
                  : "bg-surface-2 border-strong"
              }`}
              role="switch"
              aria-checked={forceSame}
              aria-label="Use same team across entries this round"
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                  forceSame ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          )}
        </div>
      )}

      {picks.length === 0 ? (
        <Card>
          <p className="text-sm text-secondary">No upcoming eligible rounds.</p>
        </Card>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {picks.map((pick) => {
            const spreadPick = spreadPicksByGw.get(pick.gw);
            const spreadMarker = getSpreadMarker(spreadPick, spreadMode);
            return (
              <PlanTile
                key={pick.gw}
                pick={pick}
                teamById={teamById}
                spreadMarker={spreadMarker}
                spreadFloorSoft={spreadFloorSoft}
                isPinned={pins.some((p) => p.gw === pick.gw)}
                manualReason={manualReasonByGw.get(pick.gw) ?? null}
                numFixtures={numFixturesByGw.get(pick.gw) ?? null}
                onClick={() => onTileClick(pick.gw)}
                onClearPin={() => onClearPin(pick.gw)}
              />
            );
          })}
        </div>
      )}

      <PlanLegend />

      {plan.reserves.length > 0 && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted">Reserves:</span>
          {plan.reserves.map((r) => {
            const team = teamById.get(r.teamId);
            return (
              <span
                key={r.teamId}
                className="flex items-center gap-1 text-xs text-warning"
                title={r.reason}
              >
                <ClubBadge code={team?.shortName} size={24} state="reserved" />
                {team?.shortName ?? `#${r.teamId}`}
                {r.targetGw != null && (
                  <span className="text-muted">→ GW{r.targetGw}</span>
                )}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ─── Competition: plan summary grid (Frame 10) ───────────────────────────────

// One at-a-glance cell per horizon round. Skip cells reuse the dashed/ban token
// at grid-cell size; a manual skip carries a small corner dot so it reads apart
// from the automatic case at grid density. Driven purely from pick.skipKind.
function SummaryCell({
  pick,
  teamById,
}: {
  pick: PlannedPick;
  teamById: Map<number, PlannerTeam>;
}) {
  const isSkipped = pick.flags.includes("skipped");

  if (isSkipped) {
    const isManual = pick.skipKind === "manual";
    return (
      <div
        className={`relative flex aspect-square flex-col items-center justify-center rounded-md border border-dashed bg-surface/50 ${
          isManual ? "border-strong" : "border-subtle opacity-60"
        }`}
        title={pick.reason}
      >
        {isManual && (
          <span
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-secondary"
            aria-hidden
          />
        )}
        <Ban
          className={`h-4 w-4 ${isManual ? "text-secondary" : "text-muted"}`}
          aria-hidden
        />
        <span
          className={`mt-0.5 text-[9px] font-semibold ${
            isManual ? "text-secondary" : "text-muted"
          }`}
        >
          GW{pick.gw}
        </span>
      </div>
    );
  }

  const team = pick.teamId != null ? teamById.get(pick.teamId) : null;
  return (
    <div
      className="flex aspect-square flex-col items-center justify-center rounded-md border border-subtle bg-surface"
      title={pick.reason}
    >
      {team ? (
        <ClubBadge code={team.shortName} size={24} />
      ) : (
        <span className="text-[10px] text-muted">—</span>
      )}
      <span className="mt-0.5 text-[9px] font-semibold text-muted">
        GW{pick.gw}
      </span>
    </div>
  );
}

function SummarySection({
  picks,
  teams,
}: {
  picks: PlannedPick[];
  teams: PlannerTeam[];
}) {
  const teamById = useMemo(
    () => new Map(teams.map((t) => [t.id, t])),
    [teams],
  );
  if (picks.length === 0) return null;
  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
        Summary
      </h2>
      <Card>
        <div
          className="grid gap-1.5"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(44px, 1fr))",
          }}
        >
          {picks.map((pick) => (
            <SummaryCell key={pick.gw} pick={pick} teamById={teamById} />
          ))}
        </div>
      </Card>
    </section>
  );
}

// Compact legend for the forward-plan tiles. Split "Skipped" into its auto and
// manual variants so the two dashed treatments read unambiguously.
function PlanLegend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-muted">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" aria-hidden />
        Matched
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-success" aria-hidden />
        Spread
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-warning" aria-hidden />
        Reserved
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm border-2 border-accent"
          aria-hidden
        />
        Manual override
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-2.5 w-3.5 rounded-sm border border-dashed border-subtle opacity-60"
          aria-hidden
        />
        Skipped · auto
      </span>
      <span className="flex items-center gap-1.5 text-secondary">
        <span className="relative inline-flex h-2.5 w-3.5 items-center justify-center rounded-sm border border-dashed border-strong">
          <Pencil className="h-2 w-2 text-secondary" aria-hidden />
        </span>
        Skipped · manual
      </span>
    </div>
  );
}

function PlanTile({
  pick,
  teamById,
  spreadMarker,
  spreadFloorSoft,
  isPinned,
  manualReason,
  numFixtures,
  onClick,
  onClearPin,
}: {
  pick: PlannedPick;
  teamById: Map<number, PlannerTeam>;
  spreadMarker?: "matched" | "spread" | "belowFloor";
  spreadFloorSoft?: number;
  isPinned: boolean;
  manualReason?: string | null;
  numFixtures?: number | null;
  onClick: () => void;
  onClearPin: () => void;
}) {
  const flags = pick.flags;
  const team = pick.teamId != null ? teamById.get(pick.teamId) : null;

  const isSkipped = flags.includes("skipped");
  const isEliteEarly = flags.includes("eliteEarly");
  const isReserveDeployed = flags.includes("reserveDeployed");
  const isPinnedFlag = flags.includes("pinned");
  const isNeedsDeploy = flags.includes("needsDeploy") && !isSkipped;
  const isNoPick = flags.includes("noPick");

  if (isSkipped) {
    // skipKind (from the planner) tells auto (fixture-count threshold) from
    // manual (user skip). Both tiles tap to open the round sheet — manual shows
    // its reason + edit/restore controls; auto shows a read-only explainer.
    if (pick.skipKind === "manual") {
      const hasReason = manualReason != null && manualReason.trim().length > 0;
      return (
        <button
          type="button"
          onClick={onClick}
          className="relative flex w-28 shrink-0 flex-col items-center justify-center rounded-lg border border-dashed border-strong bg-surface/50 px-2 py-3 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          title={pick.reason}
        >
          <Pencil
            className="absolute right-1.5 top-1.5 h-3 w-3 text-secondary"
            aria-hidden
          />
          <Ban className="h-4 w-4 text-secondary" aria-hidden />
          <span className="mt-1 text-xs font-semibold text-secondary">
            GW{pick.gw}
          </span>
          <span className="mt-0.5 text-[10px] font-medium text-secondary leading-tight">
            Skipped · manual
          </span>
          <span className="mt-0.5 w-full truncate text-[10px] text-muted leading-tight">
            {hasReason ? manualReason : "tap to add reason"}
          </span>
        </button>
      );
    }
    // auto: fixture-count threshold — muted, "N games · under {threshold}"
    const shortReason = pick.reason.split(" — ")[0]; // e.g. "under 7 fixtures"
    const games =
      numFixtures != null
        ? `${numFixtures} game${numFixtures === 1 ? "" : "s"} · `
        : "";
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex w-28 shrink-0 flex-col items-center justify-center rounded-lg border border-dashed border-subtle bg-surface/50 px-2 py-3 text-center opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:opacity-100"
        title={pick.reason}
      >
        <Ban className="h-4 w-4 text-muted" aria-hidden />
        <span className="mt-1 text-xs font-semibold text-muted">
          GW{pick.gw}
        </span>
        <span className="mt-0.5 text-[10px] text-muted leading-tight">
          Skipped · {games}
          {shortReason}
        </span>
      </button>
    );
  }

  let cardStyle: React.CSSProperties = {};
  let labelColor = "text-muted";
  let tileIcon: React.ReactNode = null;

  // Spread marker overrides card style
  const isBelowFloor = spreadMarker === "belowFloor";

  if (isBelowFloor) {
    cardStyle = { boxShadow: "inset 0 0 0 1.5px var(--warning)" };
    labelColor = "text-warning";
  } else if (isEliteEarly) {
    cardStyle = { boxShadow: "inset 0 0 0 2px var(--accent-2)" };
    labelColor = "text-hot";
    tileIcon = <Zap className="h-3.5 w-3.5 text-hot" aria-hidden />;
  } else if (isReserveDeployed) {
    cardStyle = { boxShadow: "inset 0 0 0 2px var(--warning)" };
    labelColor = "text-warning";
    tileIcon = <Clock className="h-3.5 w-3.5 text-warning" aria-hidden />;
  } else if (isPinnedFlag) {
    cardStyle = { boxShadow: "inset 0 0 0 2px var(--accent)" };
    labelColor = "text-accent";
  } else if (isNeedsDeploy || isNoPick) {
    cardStyle = { boxShadow: "inset 0 0 0 1.5px var(--border-strong)" };
    labelColor = "text-muted";
  }

  return (
    <button
      type="button"
      onClick={isPinnedFlag ? onClearPin : onClick}
      className="w-28 shrink-0 rounded-lg bg-surface border border-subtle shadow-card text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent p-2.5"
      style={cardStyle}
      title={pick.reason}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-xs font-bold uppercase tracking-wide ${labelColor}`}>
          GW{pick.gw}
        </span>
        {tileIcon}
        {pick.pWin != null && !tileIcon && (
          <span className="text-xs font-bold tnum text-accent">
            {formatPct(pick.pWin)}
          </span>
        )}
      </div>

      {team ? (
        <div className="flex items-center gap-1.5">
          <ClubBadge
            code={team.shortName}
            size={24}
            state={isPinnedFlag ? "recommended" : isReserveDeployed ? "reserved" : "default"}
          />
          <span className="text-[11px] font-semibold text-primary truncate">
            {team.shortName}
            {pick.pWin != null && tileIcon && (
              <span className="ml-0.5 text-[10px] text-muted font-normal">
                {" "}{formatPct(pick.pWin)}
              </span>
            )}
          </span>
        </div>
      ) : (
        <span className="text-[11px] text-muted">
          {isNoPick ? "No pick" : isNeedsDeploy ? "Deploy reserve" : "TBD"}
        </span>
      )}

      {isPinnedFlag && (
        <>
          <span className="mt-1 inline-block rounded border border-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent">
            Manual override
          </span>
          <span className="mt-1 block text-[10px] text-muted">Tap to clear</span>
        </>
      )}

      {/* Spread source markers */}
      {spreadMarker === "matched" && (
        <span className="mt-1 block text-[10px] font-medium text-accent">
          Matched
        </span>
      )}
      {spreadMarker === "spread" && (
        <span className="mt-1 block text-[10px] font-medium text-success">
          Spread
        </span>
      )}
      {isBelowFloor && (
        <span className="mt-1 block text-[10px] font-medium text-warning">
          Below {Math.round((spreadFloorSoft ?? 0.65) * 100)}% floor
        </span>
      )}
    </button>
  );
}

// ─── Competition: strategy ────────────────────────────────────────────────────

const SPREAD_MODE_INFO: Record<LmsSpreadMode, { blurb: string }> = {
  off: { blurb: "Never spread — each entry picks its own safest team independently." },
  soft: {
    blurb:
      "Diversify only among teams above the 65% floor — survival wins.",
  },
  strong: {
    blurb:
      "Next-best distinct team regardless of odds — can drop below 65%. Maximum spread.",
  },
};

function SpreadControl({
  spreadMode,
  spreadSaving,
  disabled,
  onSpreadModeChange,
  onAddEntry,
}: {
  spreadMode: LmsSpreadMode;
  spreadSaving: boolean;
  disabled: boolean;
  onSpreadModeChange: (mode: LmsSpreadMode) => void;
  onAddEntry: () => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="gray">COMPETITION</Badge>
        <span className="text-xs text-muted">Spread coordination across entries</span>
      </div>
      {disabled ? (
        <div className="rounded-lg border border-subtle bg-surface-2 p-3">
          <p className="text-sm text-secondary opacity-60">
            Spread needs at least two entries
          </p>
          <button
            type="button"
            onClick={onAddEntry}
            className="mt-2 flex items-center gap-1 text-xs font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add an entry
          </button>
        </div>
      ) : (
        <>
          <div
            role="radiogroup"
            aria-label="Spread mode"
            className="flex w-full rounded-lg border border-subtle bg-raised p-1"
          >
            {(
              [
                { v: "off" as LmsSpreadMode, label: "Off", activeClass: "bg-surface-2 text-primary shadow-card" },
                { v: "soft" as LmsSpreadMode, label: "Soft", activeClass: "bg-[rgba(22,225,163,0.12)] text-success shadow-card" },
                { v: "strong" as LmsSpreadMode, label: "Strong", activeClass: "bg-[rgba(245,180,0,0.12)] text-warning shadow-card" },
              ] as const
            ).map(({ v, label, activeClass }) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={spreadMode === v}
                onClick={() => onSpreadModeChange(v)}
                className={`flex-1 h-9 rounded-md px-3.5 text-sm font-semibold transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  spreadMode === v ? activeClass : "text-secondary hover:text-primary"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-secondary">
            {SPREAD_MODE_INFO[spreadMode].blurb}
          </p>
          {spreadSaving && (
            <p className="mt-1 text-xs text-muted">Saving…</p>
          )}
        </>
      )}
    </div>
  );
}

// Competition-scoped auto-skip rule — a numeric threshold + on/off toggle at the
// same visual tier as the spread control. Off = null (no fixture-count rule).
const DEFAULT_AUTO_SKIP = 7;

function AutoSkipControl({
  threshold,
  saving,
  onChange,
}: {
  threshold: number | null;
  saving: boolean;
  onChange: (n: number | null) => void;
}) {
  const enabled = threshold != null;
  const value = threshold ?? DEFAULT_AUTO_SKIP;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="gray">COMPETITION</Badge>
        <span className="text-xs text-muted">Auto-skip small rounds</span>
      </div>
      <div className="rounded-lg border border-subtle bg-surface-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              className={`text-sm font-medium ${
                enabled ? "text-secondary" : "text-secondary opacity-50"
              }`}
            >
              Skip rounds under
            </span>
            <div
              className={`flex items-center rounded-lg border border-strong bg-raised ${
                enabled ? "" : "opacity-50"
              }`}
            >
              <button
                type="button"
                disabled={!enabled || value <= 1}
                onClick={() => onChange(value - 1)}
                aria-label="Decrease fixture threshold"
                className="flex h-8 w-8 items-center justify-center text-secondary hover:text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-l-lg"
              >
                <Minus className="h-3.5 w-3.5" aria-hidden />
              </button>
              <span className="w-8 text-center text-sm font-bold tnum text-primary">
                {value}
              </span>
              <button
                type="button"
                disabled={!enabled}
                onClick={() => onChange(value + 1)}
                aria-label="Increase fixture threshold"
                className="flex h-8 w-8 items-center justify-center text-secondary hover:text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-r-lg"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
            <span
              className={`text-sm ${
                enabled ? "text-secondary" : "text-secondary opacity-50"
              }`}
            >
              PL fixtures
            </span>
          </div>
          <Toggle
            checked={enabled}
            onChange={(on) => onChange(on ? DEFAULT_AUTO_SKIP : null)}
            aria-label="Auto-skip rule on or off"
          />
        </div>
        {!enabled && (
          <p className="mt-2 text-xs text-muted">
            No fixture-count rule for this competition — skip rounds manually
            instead.
          </p>
        )}
        {saving && <p className="mt-1 text-xs text-muted">Saving…</p>}
      </div>
    </div>
  );
}

function StrategySection({
  entry,
  strategyMode,
  floorPct,
  reserveIds,
  saving,
  spreadMode,
  spreadSaving,
  totalEntryCount,
  autoSkipThreshold,
  autoSkipSaving,
  onStrategyChange,
  onFloorChange,
  onFloorCommit,
  onReserveToggle,
  onSpreadModeChange,
  onAutoSkipChange,
  onAddEntry,
}: {
  entry: LmsEntryDetail;
  strategyMode: LmsReserveStrategy;
  floorPct: number;
  reserveIds: number[];
  saving: boolean;
  spreadMode: LmsSpreadMode;
  spreadSaving: boolean;
  totalEntryCount: number;
  autoSkipThreshold: number | null;
  autoSkipSaving: boolean;
  onStrategyChange: (mode: LmsReserveStrategy) => void;
  onFloorChange: (pct: number) => void;
  onFloorCommit: (pct: number) => void;
  onReserveToggle: (teamId: number) => void;
  onSpreadModeChange: (mode: LmsSpreadMode) => void;
  onAutoSkipChange: (n: number | null) => void;
  onAddEntry: () => void;
}) {
  // Available teams for the manual reserve tray
  const availableForReserve = entry.teams.filter((t) => !t.used);
  const spreadDisabled = totalEntryCount < 2;

  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
        Strategy
      </h2>
      <Card>
        <div className="space-y-4">
          {/* Competition-scoped spread control */}
          <SpreadControl
            spreadMode={spreadMode}
            spreadSaving={spreadSaving}
            disabled={spreadDisabled}
            onSpreadModeChange={onSpreadModeChange}
            onAddEntry={onAddEntry}
          />

          {/* Competition-scoped auto-skip rule */}
          <AutoSkipControl
            threshold={autoSkipThreshold}
            saving={autoSkipSaving}
            onChange={onAutoSkipChange}
          />

          <div className="border-t border-subtle pt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
              Entry reserve strategy
            </p>
            <SegmentedControl
              aria-label="Reserve strategy"
              options={STRATEGY_OPTIONS}
              value={strategyMode}
              onValueChange={(v) => onStrategyChange(v as LmsReserveStrategy)}
              fullWidth
            />
            <StrategyHelp mode={strategyMode} />
            {saving && (
              <p className="mt-1.5 text-xs text-muted">Saving…</p>
            )}
          </div>

          {strategyMode !== "safest" && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-secondary">
                Confidence floor: {floorPct}%
              </label>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={floorPct}
                onChange={(e) => onFloorChange(Number(e.target.value))}
                onMouseUp={(e) =>
                  onFloorCommit(Number((e.target as HTMLInputElement).value))
                }
                onTouchEnd={(e) =>
                  onFloorCommit(Number((e.target as HTMLInputElement).value))
                }
                className="w-full accent-accent"
              />
              <div className="mt-0.5 flex justify-between text-[11px] text-muted">
                <span>0%</span>
                <span>100%</span>
              </div>
            </div>
          )}

          {strategyMode === "manual" && (
            <div>
              <p className="mb-2 text-xs font-medium text-secondary">
                Reserve teams (excluded from auto allocation):
              </p>
              {availableForReserve.length === 0 ? (
                <p className="text-xs text-muted">No available teams to reserve.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {availableForReserve.map((t) => {
                    const isReserved = reserveIds.includes(t.team.fpl_id);
                    return (
                      <button
                        key={t.team.fpl_id}
                        type="button"
                        onClick={() => onReserveToggle(t.team.fpl_id)}
                        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-semibold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                          isReserved
                            ? "border-warning bg-[rgba(245,180,0,0.12)] text-warning"
                            : "border-subtle bg-surface-2 text-secondary hover:text-primary"
                        }`}
                        aria-pressed={isReserved}
                        title={isReserved ? `Unreserve ${t.team.name}` : `Reserve ${t.team.name}`}
                      >
                        <ClubBadge
                          code={t.team.short_name}
                          size={24}
                          state={isReserved ? "reserved" : "default"}
                        />
                        {t.team.short_name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}

// ─── Competition: used & remaining ───────────────────────────────────────────

function UsedRemainingSection({ entry }: { entry: LmsEntryDetail }) {
  const used = entry.teams.filter((t) => t.used);
  const available = entry.teams.filter((t) => !t.used);

  return (
    <section className="mb-5 space-y-4">
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
          Used this season
        </h2>
        {used.length === 0 ? (
          <Card>
            <p className="text-sm text-secondary">
              No teams used yet — every side is still available.
            </p>
          </Card>
        ) : (
          <div className="flex flex-wrap gap-3">
            {entry.picks.map((p) => (
              <div
                key={`${p.gw}-${p.team?.fpl_id ?? "x"}`}
                className="flex flex-col items-center gap-1"
              >
                <ClubBadge
                  code={p.team?.short_name}
                  size={44}
                  state="used"
                  title={`${p.team?.name ?? "Team"} · GW${p.gw}`}
                />
                <span className="text-[11px] font-medium text-muted">
                  GW{p.gw}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
          Available · {available.length}
        </h2>
        {available.length === 0 ? (
          <Card>
            <p className="text-sm text-secondary">
              All teams have been used — start of a new season?
            </p>
          </Card>
        ) : (
          <div className="flex flex-wrap gap-2">
            {available.map((t) => (
              <ClubBadge
                key={t.team.fpl_id}
                code={t.team.short_name}
                size={32}
                state={t.reserved ? "reserved" : "default"}
                title={`${t.team.name}${t.reserved ? " (reserved)" : ""}`}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Eliminated entry view ────────────────────────────────────────────────────

function EliminatedView({
  entry,
  allEntries,
  onSwitchEntry,
  onAddEntry,
}: {
  entry: LmsEntryDetail;
  allEntries: LmsEntryData[];
  onSwitchEntry: (id: number) => void;
  onAddEntry: () => void;
}) {
  const eliminatingPick = entry.picks.find((p) => p.result === "eliminated");
  const aliveEntries = allEntries.filter((e) => e.detail.status === "alive");

  return (
    <div className="space-y-4">
      {/* Knocked out header */}
      <Card className="border-danger bg-[rgba(244,63,94,0.06)]">
        <div className="flex items-center gap-3">
          {eliminatingPick?.team && (
            <ClubBadge
              code={eliminatingPick.team.short_name}
              size={44}
              state="out"
            />
          )}
          <div>
            <p className="text-base font-bold text-danger">
              Knocked out
              {entry.eliminatedGw != null
                ? ` · GW${entry.eliminatedGw}`
                : ""}
            </p>
            {eliminatingPick && (
              <p className="text-sm text-secondary">
                {eliminatingPick.team?.name ?? "Team"} ·{" "}
                <span className="capitalize">{eliminatingPick.result}</span>
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Run history */}
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
          Run history
        </h2>
        <div className="space-y-1.5">
          {entry.picks.length === 0 ? (
            <p className="text-sm text-secondary">No picks recorded.</p>
          ) : (
            entry.picks.map((p) => {
              const survived = p.result === "survived";
              const out = p.result === "eliminated";
              return (
                <div
                  key={p.gw}
                  className="flex items-center gap-3 rounded-lg border border-subtle bg-surface px-3 py-2"
                >
                  <ClubBadge
                    code={p.team?.short_name}
                    size={32}
                    state={out ? "out" : survived ? "default" : "default"}
                  />
                  <span className="flex-1 text-sm font-medium text-primary">
                    {p.team?.name ?? "Unknown"}{" "}
                    <span className="text-xs text-muted">GW{p.gw}</span>
                  </span>
                  <Badge
                    tone={
                      out
                        ? "danger"
                        : survived
                          ? "success"
                          : "gray"
                    }
                  >
                    {out ? "Out" : survived ? "Survived" : "Pending"}
                  </Badge>
                </div>
              );
            })
          )}
        </div>
      </div>

      {aliveEntries.length > 0 && (
        <Callout tone="success" title="Your other entries are still alive">
          {aliveEntries.map((e) => e.detail.label).join(", ")}
        </Callout>
      )}

      <div className="flex gap-2">
        {aliveEntries.length > 0 && (
          <Button
            variant="secondary"
            onClick={() => onSwitchEntry(aliveEntries[0].detail.id)}
          >
            Switch entry
          </Button>
        )}
        <Button icon={<Plus />} onClick={onAddEntry}>
          Start new entry
        </Button>
      </div>
    </div>
  );
}

// ─── Sheet: Add Competition ───────────────────────────────────────────────────

type CompVariant = "new" | "inflight";

interface BackfillPick {
  gw: string;
  teamId: string;
}

function AddCompSheet({
  open,
  onClose,
  allTeams,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  allTeams: Team[];
  onCreated: (compId: number) => void;
}) {
  const [variant, setVariant] = useState<CompVariant>("new");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("Entry 1");
  const [strategy, setStrategyLocal] = useState<LmsReserveStrategy>("smart");
  const [startGw, setStartGw] = useState("1");
  const [backfill, setBackfill] = useState<BackfillPick[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setVariant("new");
    setName("");
    setLabel("Entry 1");
    setStrategyLocal("smart");
    setStartGw("1");
    setBackfill([]);
    setError(null);
  }

  function addBackfillRow() {
    setBackfill((prev) => [...prev, { gw: "", teamId: "" }]);
  }

  function removeBackfillRow(i: number) {
    setBackfill((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateBackfillRow(i: number, field: keyof BackfillPick, value: string) {
    setBackfill((prev) =>
      prev.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)),
    );
  }

  async function handleSubmit() {
    setError(null);
    const n = name.trim();
    if (!n) {
      setError("Enter a competition name.");
      return;
    }
    const l = label.trim();
    if (!l) {
      setError("Enter an entry label.");
      return;
    }

    const sgw = variant === "new" ? 1 : parseInt(startGw, 10);
    if (!Number.isInteger(sgw) || sgw < 1) {
      setError("Enter a valid starting gameweek.");
      return;
    }

    const picks = variant === "inflight"
      ? backfill
          .filter((r) => r.gw !== "" && r.teamId !== "")
          .map((r) => ({ gw: Number(r.gw), teamId: Number(r.teamId) }))
      : undefined;

    setSaving(true);
    try {
      const res = await createCompetition({
        name: n,
        startGw: sgw,
        entries: [{ label: l, backfillPicks: picks }],
      });
      if (res.ok && res.competitionId) {
        reset();
        onCreated(res.competitionId);
      } else {
        setError(res.error ?? "Could not create competition.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const variantOptions: { value: CompVariant; label: string }[] = [
    { value: "new", label: "New game" },
    { value: "inflight", label: "Joining in-flight" },
  ];

  return (
    <BottomSheet
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Add Competition"
    >
      <div className="space-y-4">
        <SegmentedControl
          aria-label="Competition type"
          options={variantOptions}
          value={variant}
          onValueChange={(v) => setVariant(v as CompVariant)}
          fullWidth
        />

        <Input
          label="Competition name"
          placeholder="e.g. Sphinx LMS 2026/27"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {variant === "inflight" && (
          <Input
            label="Competition started at (GW)"
            type="number"
            min={1}
            max={38}
            placeholder="1"
            value={startGw}
            onChange={(e) => setStartGw(e.target.value)}
            hint="The first gameweek of this competition."
          />
        )}

        <Input
          label="First entry label"
          placeholder="Entry 1"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />

        <div>
          <label className="mb-1.5 block text-sm font-medium text-secondary">
            Reserve strategy
          </label>
          <SegmentedControl
            aria-label="Reserve strategy"
            options={STRATEGY_OPTIONS}
            value={strategy}
            onValueChange={(v) => setStrategyLocal(v as LmsReserveStrategy)}
            fullWidth
          />
          <StrategyHelp mode={strategy} />
        </div>

        {variant === "inflight" && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-secondary">
                Prior picks (backfill)
              </p>
              <Button size="sm" variant="ghost" icon={<Plus />} onClick={addBackfillRow}>
                Add round
              </Button>
            </div>
            {backfill.length === 0 ? (
              <p className="text-xs text-muted">
                Add rounds you already played before tracking here.
              </p>
            ) : (
              <div className="space-y-2">
                {backfill.map((row, i) => (
                  <div key={i} className="flex gap-2 items-end">
                    <div className="w-20 shrink-0">
                      <Input
                        label={i === 0 ? "GW" : undefined}
                        type="number"
                        min={1}
                        max={38}
                        placeholder="GW#"
                        value={row.gw}
                        onChange={(e) => updateBackfillRow(i, "gw", e.target.value)}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <label
                        className={`mb-1.5 block text-sm font-medium text-secondary ${i === 0 ? "" : "sr-only"}`}
                      >
                        Team
                      </label>
                      <select
                        value={row.teamId}
                        onChange={(e) =>
                          updateBackfillRow(i, "teamId", e.target.value)
                        }
                        className="h-11 w-full rounded-lg border border-strong bg-raised px-3 text-sm text-primary focus:outline-none focus:ring-1 focus:border-accent focus:ring-accent"
                      >
                        <option value="">Select team…</option>
                        {allTeams.map((t) => (
                          <option key={t.fpl_id} value={t.fpl_id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeBackfillRow(i)}
                      className="mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-subtle text-secondary hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      aria-label="Remove row"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} disabled={saving} fullWidth>
            {saving ? "Creating…" : "Create competition"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => { reset(); onClose(); }}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

// ─── Sheet: Add Entry ─────────────────────────────────────────────────────────

function AddEntrySheet({
  open,
  onClose,
  competitionId,
  willAutoSoft,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  competitionId: number;
  willAutoSoft: boolean;
  onAdded: () => void;
}) {
  const [label, setLabel] = useState("");
  const [strategy, setStrategyLocal] = useState<LmsReserveStrategy>("smart");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSoftHint, setShowSoftHint] = useState(false);

  function reset() {
    setLabel("");
    setStrategyLocal("smart");
    setError(null);
    setShowSoftHint(false);
  }

  async function handleSubmit() {
    setError(null);
    const l = label.trim();
    if (!l) {
      setError("Enter an entry label.");
      return;
    }
    setSaving(true);
    try {
      const res = await addEntry(competitionId, l, strategy);
      if (res.ok) {
        if (willAutoSoft) {
          setShowSoftHint(true);
        } else {
          reset();
          onAdded();
        }
      } else {
        setError(res.error ?? "Could not add entry.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function handleSoftHintContinue() {
    reset();
    onAdded();
  }

  return (
    <BottomSheet
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Add Entry"
    >
      {showSoftHint ? (
        <div className="space-y-4">
          <Callout tone="success" title="Entry added">
            Spread turned on (Soft) — diversify only above the 65% floor.
            Change it any time in the strategy card.
          </Callout>
          <Button onClick={handleSoftHintContinue} fullWidth>
            Got it
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <Input
            label="Entry label"
            placeholder="Entry 2"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />

          <div>
            <label className="mb-1.5 block text-sm font-medium text-secondary">
              Reserve strategy
            </label>
            <SegmentedControl
              aria-label="Reserve strategy"
              options={STRATEGY_OPTIONS}
              value={strategy}
              onValueChange={(v) => setStrategyLocal(v as LmsReserveStrategy)}
              fullWidth
            />
            <StrategyHelp mode={strategy} />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button onClick={handleSubmit} disabled={saving} fullWidth>
              {saving ? "Adding…" : "Add entry"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => { reset(); onClose(); }}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

// ─── Sheet: Submit confirm ────────────────────────────────────────────────────

function SubmitConfirmSheet({
  pick,
  currentGw,
  entryId,
  onClose,
  onSubmitted,
}: {
  pick: RankedPick | null;
  currentGw: number | null;
  entryId: number | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!pick || currentGw == null || entryId == null) return;
    setError(null);
    setSaving(true);
    try {
      const res = await submitPick(entryId, currentGw, pick.team.fpl_id);
      if (res.ok) {
        onSubmitted();
      } else {
        setError(res.error ?? "Could not record your pick.");
      }
    } catch {
      setError("Could not record your pick. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet
      open={pick != null}
      onClose={() => { setError(null); onClose(); }}
      title="Confirm your pick"
    >
      {pick ? (
        <div className="space-y-4">
          {/* Pick summary */}
          <div className="flex items-center gap-3">
            <ClubBadge code={pick.team.short_name} size={44} state="recommended" />
            <div>
              <p className="text-base font-bold text-primary">
                {pick.team.name}{" "}
                <span className="text-sm font-medium text-secondary">
                  ({pick.isHome ? "H" : "A"})
                </span>
              </p>
              <p className="text-sm text-secondary">
                v {pick.opponent?.name ?? "TBD"} ·{" "}
                <span className="font-semibold text-accent">
                  {formatPct(pick.pWin)} win
                </span>
              </p>
            </div>
          </div>

          <ProbBar home={pick.pWin} draw={pick.pDraw} away={pick.pLoss} showLabels />

          {/* Draw = OUT — THE only place this rule appears */}
          <Callout tone="danger" title="Draw = OUT">
            A draw eliminates you just like a loss. Your team must win
            outright. This pick locks GW{currentGw ?? "?"} and cannot be
            changed.
          </Callout>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button onClick={handleConfirm} disabled={saving} fullWidth>
              {saving ? "Recording…" : "Confirm pick"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => { setError(null); onClose(); }}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-secondary">No pick selected.</p>
      )}
    </BottomSheet>
  );
}

// ─── Sheet: Deadline override ─────────────────────────────────────────────────

function DeadlineOverrideSheet({
  open,
  onClose,
  competitionId,
  currentGw,
  fixtures,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  competitionId: number;
  currentGw: number | null;
  fixtures: LmsGameweekFixture[];
  onSaved: () => void;
}) {
  const [useCustom, setUseCustom] = useState(false);
  const [customDatetime, setCustomDatetime] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Compute the default deadline: day before first fixture kickoff
  const defaultDeadline = useMemo(() => {
    if (currentGw == null) return null;
    const fixtureDates = fixtures.map((f) => ({ gw: f.gw, kickoff: f.kickoff }));
    return computeDefaultDeadline(currentGw, fixtureDates);
  }, [currentGw, fixtures]);

  const defaultLabel = defaultDeadline
    ? new Date(defaultDeadline).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not available";

  async function handleSave() {
    if (currentGw == null) return;
    setError(null);
    setSaving(true);

    const deadline = useCustom
      ? customDatetime
        ? new Date(customDatetime).toISOString()
        : null
      : defaultDeadline;

    try {
      const res = await setRoundDeadline(competitionId, currentGw, deadline);
      if (res.ok) {
        onSaved();
      } else {
        setError(res.error ?? "Could not save deadline.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={() => { setError(null); onClose(); }}
      title={`GW${currentGw ?? "?"} deadline`}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          {/* Default option */}
          <button
            type="button"
            onClick={() => setUseCustom(false)}
            className={`w-full rounded-lg border p-3 text-left transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              !useCustom
                ? "border-accent bg-[rgba(22,225,163,0.06)]"
                : "border-subtle bg-surface"
            }`}
          >
            <p className="text-sm font-semibold text-primary">
              Day before first fixture
            </p>
            <p className="mt-0.5 text-xs text-secondary">{defaultLabel}</p>
          </button>

          {/* Custom option */}
          <button
            type="button"
            onClick={() => setUseCustom(true)}
            className={`w-full rounded-lg border p-3 text-left transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              useCustom
                ? "border-accent bg-[rgba(22,225,163,0.06)]"
                : "border-subtle bg-surface"
            }`}
          >
            <p className="text-sm font-semibold text-primary">
              Custom date &amp; time
            </p>
          </button>

          {useCustom && (
            <input
              type="datetime-local"
              value={customDatetime}
              onChange={(e) => setCustomDatetime(e.target.value)}
              className="h-11 w-full rounded-lg border border-strong bg-raised px-3 text-sm text-primary focus:outline-none focus:ring-1 focus:border-accent focus:ring-accent"
            />
          )}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving} fullWidth>
            {saving ? "Saving…" : "Save deadline"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => { setError(null); onClose(); }}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

// ─── Sheet: Pin picker (forward-plan round override) ─────────────────────────

function PinPickerSheet({
  gw,
  onClose,
  fixtureProbs,
  teams,
  excludedTeamIds,
  onSelect,
  skipStatus,
  manualReason,
  skipSaving,
  onSkip,
  onUnskip,
  spreadActive,
}: {
  gw: number | null;
  onClose: () => void;
  fixtureProbs: PlannerFixtureProb[];
  teams: PlannerTeam[];
  excludedTeamIds: number[];
  onSelect: (gw: number, teamId: number) => void;
  skipStatus: RoundSkipStatus | null;
  manualReason: string | null;
  skipSaving: boolean;
  onSkip: (gw: number, reason?: string) => void;
  onUnskip: (gw: number) => void;
  /** Spread is coordinating this competition (soft/strong + ≥2 alive entries). */
  spreadActive: boolean;
}) {
  const teamMap = useMemo(
    () => new Map(teams.map((t) => [t.id, t])),
    [teams],
  );

  // Reason drafts: `reasonDraft` for skipping a normal round; `editReason` for
  // the manual-skip edit-reason flow (null = not editing). Reset when the sheet
  // switches rounds.
  const [reasonDraft, setReasonDraft] = useState("");
  const [editReason, setEditReason] = useState<string | null>(null);
  useEffect(() => {
    setReasonDraft("");
    setEditReason(null);
  }, [gw]);

  const candidates = useMemo(() => {
    if (gw == null) return [];
    const excluded = new Set(excludedTeamIds);
    const arr: { teamId: number; shortName: string; pWin: number; isHome: boolean }[] = [];

    for (const fp of fixtureProbs) {
      if (fp.gw !== gw) continue;
      if (!excluded.has(fp.homeTeamId) && fp.pHome != null) {
        const t = teamMap.get(fp.homeTeamId);
        if (t) arr.push({ teamId: fp.homeTeamId, shortName: t.shortName, pWin: fp.pHome, isHome: true });
      }
      if (!excluded.has(fp.awayTeamId) && fp.pAway != null) {
        const t = teamMap.get(fp.awayTeamId);
        if (t) arr.push({ teamId: fp.awayTeamId, shortName: t.shortName, pWin: fp.pAway, isHome: false });
      }
    }

    return arr.sort((a, b) => b.pWin - a.pWin);
  }, [gw, fixtureProbs, teamMap, excludedTeamIds]);

  const isManualSkip = skipStatus?.skipped === true && skipStatus.kind === "manual";
  const isAutoSkip = skipStatus?.skipped === true && skipStatus.kind === "auto";

  const title =
    gw == null
      ? undefined
      : isManualSkip
        ? `GW${gw} skipped`
        : isAutoSkip
          ? `GW${gw} auto-skipped`
          : `Override GW${gw} pick`;

  return (
    <BottomSheet open={gw != null} onClose={onClose} title={title}>
      {isManualSkip ? (
        // ── Already manually skipped: edit reason / restore / keep ────────────
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <Ban className="mt-0.5 h-4 w-4 shrink-0 text-secondary" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-secondary">
                Skipped manually
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {manualReason && manualReason.trim().length > 0
                  ? manualReason
                  : "No reason given."}
              </p>
            </div>
          </div>

          {editReason != null ? (
            <div className="space-y-2">
              <Input
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
                placeholder="Reason (optional)"
                aria-label="Edit skip reason"
              />
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={skipSaving}
                  onClick={() => gw != null && onSkip(gw, editReason)}
                >
                  Save reason
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditReason(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditReason(manualReason ?? "")}
              className="flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit reason
            </button>
          )}

          <div className="border-t border-subtle pt-3">
            <Button
              variant="secondary"
              fullWidth
              disabled={skipSaving}
              onClick={() => gw != null && onUnskip(gw)}
            >
              Restore auto-pick
            </Button>
            <p className="mt-1.5 text-xs text-muted">
              Returns this round to a normal planned pick.
            </p>
            <Button
              variant="ghost"
              fullWidth
              onClick={onClose}
              className="mt-2"
            >
              Keep skipped
            </Button>
          </div>
        </div>
      ) : isAutoSkip ? (
        // ── Auto-skipped: read-only explainer (governed by the threshold) ─────
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <Ban className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-muted">Auto-skipped</p>
              <p className="mt-0.5 text-xs text-muted">
                {skipStatus?.skipped ? skipStatus.reason : ""}
              </p>
            </div>
          </div>
          <Callout tone="info">
            This round is governed by the competition&rsquo;s auto-skip
            threshold. Change &ldquo;Auto-skip small rounds&rdquo; in Strategy to
            include it.
          </Callout>
          <Button variant="ghost" onClick={onClose} fullWidth>
            Close
          </Button>
        </div>
      ) : (
        // ── Normal round: pick-override list + quiet "Skip this round" ────────
        <div className="space-y-2">
          {spreadActive && (
            <Callout tone="warning">
              Overriding takes this round out of the coordinated spread for this
              entry — your other entries keep coordinating around your pick.
            </Callout>
          )}
          <p className="text-xs text-muted">
            Choose a team for GW{gw}. This overrides the plan in your browser
            only — nothing is saved until you submit the actual pick.
          </p>
          {candidates.length === 0 ? (
            <p className="text-sm text-secondary">
              No available teams with model data for this round.
            </p>
          ) : (
            candidates.map((c) => (
              <button
                key={c.teamId}
                type="button"
                onClick={() => gw != null && onSelect(gw, c.teamId)}
                className="flex w-full items-center gap-3 rounded-lg border border-subtle bg-surface px-3 py-2.5 text-left hover:border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ClubBadge code={c.shortName} size={32} />
                <span className="flex-1 text-sm font-semibold text-primary">
                  {c.shortName}{" "}
                  <span className="text-xs font-normal text-secondary">
                    ({c.isHome ? "H" : "A"})
                  </span>
                </span>
                <span className="text-sm font-bold tnum text-accent">
                  {formatPct(c.pWin)}
                </span>
              </button>
            ))
          )}

          {/* Quiet, subordinate skip action — not a primary button */}
          <div className="mt-1 border-t border-subtle pt-3">
            <Input
              value={reasonDraft}
              onChange={(e) => setReasonDraft(e.target.value)}
              placeholder="Reason (optional)"
              aria-label="Skip reason"
            />
            <button
              type="button"
              disabled={skipSaving}
              onClick={() => gw != null && onSkip(gw, reasonDraft)}
              className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-secondary hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded disabled:opacity-50"
            >
              <Ban className="h-3.5 w-3.5" aria-hidden /> Skip this round
            </button>
            <p className="mt-1 text-xs text-muted">
              No pick required — single-use teams stay untouched.
            </p>
          </div>

          <Button variant="ghost" onClick={onClose} fullWidth className="mt-2">
            Cancel
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}
