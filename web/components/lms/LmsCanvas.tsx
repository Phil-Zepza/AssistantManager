"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock,
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
} from "@/components/ui";
import {
  computeForwardPlan,
  computeDefaultDeadline,
  type ForwardPlan,
  type PlannerPin,
  type PlannerFixtureProb,
  type PlannerTeam,
} from "@/lib/lmsPlanner";
import {
  createCompetition,
  addEntry,
  submitPick,
  setStrategy,
  setReserves,
  setRoundDeadline,
} from "@/app/actions";
import { formatPct } from "@/lib/format";
import type {
  LmsCompetitionDetail,
  LmsCompetitionSummary,
  LmsEntryDetail,
  LmsGameweekFixture,
  LmsReserveStrategy,
  Team,
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
  currentGw: number | null;
  firstEntryId: number;
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

function getRankedPicks(
  fixtures: LmsGameweekFixture[],
  usedTeamIds: number[],
  n = 3,
): RankedPick[] {
  const used = new Set(usedTeamIds);
  const candidates: RankedPick[] = [];

  for (const f of fixtures) {
    const homeUsed = f.homeTeam != null && used.has(f.homeTeam.fpl_id);
    const awayUsed = f.awayTeam != null && used.has(f.awayTeam.fpl_id);
    const pH = f.pHome;
    const pA = f.pAway;

    if (!homeUsed && f.homeTeam && pH != null) {
      if (!awayUsed && f.awayTeam && pA != null && pA > pH) {
        candidates.push({
          fixtureId: f.fixtureId,
          fixture: f,
          team: f.awayTeam,
          opponent: f.homeTeam,
          pWin: pA,
          pDraw: f.pDraw,
          pLoss: pH,
          isHome: false,
        });
      } else {
        candidates.push({
          fixtureId: f.fixtureId,
          fixture: f,
          team: f.homeTeam,
          opponent: f.awayTeam,
          pWin: pH,
          pDraw: f.pDraw,
          pLoss: pA ?? null,
          isHome: true,
        });
      }
    } else if (!awayUsed && f.awayTeam && pA != null) {
      candidates.push({
        fixtureId: f.fixtureId,
        fixture: f,
        team: f.awayTeam,
        opponent: f.homeTeam,
        pWin: pA,
        pDraw: f.pDraw,
        pLoss: pH ?? null,
        isHome: false,
      });
    }
  }

  return candidates.sort((a, b) => b.pWin - a.pWin).slice(0, n);
}

function findCompetitionDeadline(
  competitions: LmsCompetitionSummary[],
  compId: number,
): { gw: number; deadline: string | null } | null {
  return competitions.find((c) => c.id === compId)?.nextDeadline ?? null;
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
  const plan = useMemo((): ForwardPlan | null => {
    if (!planInputs) return null;
    return computeForwardPlan({
      ...planInputs,
      entryState: {
        ...planInputs.entryState,
        strategy: strategyMode,
        confidenceFloor: floorPct / 100,
        reservedTeamIds: strategyMode === "manual" ? reserveIds : [],
      },
      pins,
    });
  }, [planInputs, strategyMode, floorPct, reserveIds, pins]);

  const usedTeamIds = selectedEntry?.detail.usedTeamIds ?? [];

  const rankedPicks = useMemo(
    () => getRankedPicks(compDetail?.fixtures ?? [], usedTeamIds),
    [compDetail?.fixtures, usedTeamIds],
  );

  const currentGw = compDetail?.currentGw ?? null;

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

  // ── Pin override handlers ──────────────────────────────────────────────────

  function handlePinSelect(gw: number, teamId: number) {
    setPins((prev) => [...prev.filter((p) => p.gw !== gw), { gw, teamId }]);
    setOverrideGw(null);
  }

  function handleClearPin(gw: number) {
    setPins((prev) => prev.filter((p) => p.gw !== gw));
  }

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
          />

          <Top3Section
            currentGw={currentGw}
            rankedPicks={rankedPicks}
            alreadyLocked={
              !!selectedEntry?.detail.picks.some((p) => p.gw === currentGw)
            }
            onBackPick={(pick) => setConfirmPick(pick)}
          />

          {plan && (
            <ForwardPlanSection
              plan={plan}
              planInputs={planInputs!}
              pins={pins}
              usedTeamIds={usedTeamIds}
              onTileClick={(gw) => setOverrideGw(gw)}
              onClearPin={handleClearPin}
            />
          )}

          {selectedEntry && (
            <StrategySection
              entry={selectedEntry.detail}
              strategyMode={strategyMode}
              floorPct={floorPct}
              reserveIds={reserveIds}
              saving={strategySaving}
              onStrategyChange={handleStrategyChange}
              onFloorChange={setFloorPct}
              onFloorCommit={handleFloorCommit}
              onReserveToggle={handleReserveToggle}
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

function EntryHeader({
  competition,
  entries,
  selectedEntryId,
  onSelectEntry,
  onAddEntry,
  currentGw,
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

          {nextDeadline?.deadline && (
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
}: {
  fixtures: LmsGameweekFixture[];
  currentGw: number | null;
  usedTeamIds: number[];
}) {
  const used = new Set(usedTeamIds);

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
          {fixtures.map((f) => {
            const homeUsed = f.homeTeam != null && used.has(f.homeTeam.fpl_id);
            const awayUsed = f.awayTeam != null && used.has(f.awayTeam.fpl_id);
            return (
              <Card key={f.fixtureId} padding="sm">
                <div className="flex items-center gap-3">
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
                    <ProbBar
                      home={f.pHome}
                      draw={f.pDraw}
                      away={f.pAway}
                    />
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
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ─── Competition: top-3 picks ─────────────────────────────────────────────────

function Top3Section({
  currentGw,
  rankedPicks,
  alreadyLocked,
  onBackPick,
}: {
  currentGw: number | null;
  rankedPicks: RankedPick[];
  alreadyLocked: boolean;
  onBackPick: (pick: RankedPick) => void;
}) {
  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
        Top 3 picks{currentGw != null ? ` · GW${currentGw}` : ""}
      </h2>

      {rankedPicks.length === 0 ? (
        <Card>
          <p className="text-sm text-secondary">
            {alreadyLocked
              ? "Pick already locked for this round."
              : "No ranked options yet — win probabilities appear once the model has run."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {rankedPicks.map((pick, i) => (
            <PickCard
              key={pick.fixtureId}
              pick={pick}
              rank={i + 1}
              alreadyLocked={alreadyLocked}
              onBackPick={onBackPick}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PickCard({
  pick,
  rank,
  alreadyLocked,
  onBackPick,
}: {
  pick: RankedPick;
  rank: number;
  alreadyLocked: boolean;
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
          <Badge tone="accent">#1 · Safest banker</Badge>
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

        {!alreadyLocked && (
          <Button
            className="mt-3 w-full"
            onClick={() => onBackPick(pick)}
          >
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
        {!alreadyLocked && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onBackPick(pick)}
          >
            Back
          </Button>
        )}
      </div>
    </Card>
  );
}

// ─── Competition: forward plan ────────────────────────────────────────────────

function ForwardPlanSection({
  plan,
  planInputs,
  pins,
  usedTeamIds,
  onTileClick,
  onClearPin,
}: {
  plan: ForwardPlan;
  planInputs: ForwardPlanInputs;
  pins: PlannerPin[];
  usedTeamIds: number[];
  onTileClick: (gw: number) => void;
  onClearPin: (gw: number) => void;
}) {
  const teamById = new Map(planInputs.teams.map((t) => [t.id, t]));

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

      {plan.picks.length === 0 ? (
        <Card>
          <p className="text-sm text-secondary">No upcoming eligible rounds.</p>
        </Card>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {plan.picks.map((pick) => (
            <PlanTile
              key={pick.gw}
              pick={pick}
              teamById={teamById}
              isPinned={pins.some((p) => p.gw === pick.gw)}
              onClick={() => onTileClick(pick.gw)}
              onClearPin={() => onClearPin(pick.gw)}
            />
          ))}
        </div>
      )}

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

function PlanTile({
  pick,
  teamById,
  isPinned,
  onClick,
  onClearPin,
}: {
  pick: ReturnType<typeof computeForwardPlan>["picks"][0];
  teamById: Map<number, PlannerTeam>;
  isPinned: boolean;
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
    return (
      <div className="flex w-28 shrink-0 flex-col items-center justify-center rounded-lg border border-dashed border-subtle bg-surface/50 px-2 py-3 text-center opacity-50">
        <span className="text-xs font-semibold text-muted">GW{pick.gw}</span>
        <span className="mt-0.5 text-[10px] text-muted leading-tight">
          Skipped · under 7
        </span>
      </div>
    );
  }

  let cardStyle: React.CSSProperties = {};
  let labelColor = "text-muted";
  let tileIcon: React.ReactNode = null;

  if (isEliteEarly) {
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
        <span className="mt-1 block text-[10px] text-accent">Tap to clear</span>
      )}
    </button>
  );
}

// ─── Competition: strategy ────────────────────────────────────────────────────

function StrategySection({
  entry,
  strategyMode,
  floorPct,
  reserveIds,
  saving,
  onStrategyChange,
  onFloorChange,
  onFloorCommit,
  onReserveToggle,
}: {
  entry: LmsEntryDetail;
  strategyMode: LmsReserveStrategy;
  floorPct: number;
  reserveIds: number[];
  saving: boolean;
  onStrategyChange: (mode: LmsReserveStrategy) => void;
  onFloorChange: (pct: number) => void;
  onFloorCommit: (pct: number) => void;
  onReserveToggle: (teamId: number) => void;
}) {
  const strategyOptions: { value: LmsReserveStrategy; label: string }[] = [
    { value: "safest", label: "Safest" },
    { value: "manual", label: "Manual" },
    { value: "smart", label: "Smart" },
  ];

  // Available teams for the manual reserve tray
  const availableForReserve = entry.teams.filter((t) => !t.used);

  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
        Strategy
      </h2>
      <Card>
        <div className="space-y-4">
          <div>
            <SegmentedControl
              aria-label="Reserve strategy"
              options={strategyOptions}
              value={strategyMode}
              onValueChange={(v) => onStrategyChange(v as LmsReserveStrategy)}
              fullWidth
            />
            {saving && (
              <p className="mt-1.5 text-xs text-muted">Saving…</p>
            )}
          </div>

          {strategyMode === "safest" && (
            <p className="text-xs text-secondary">
              Always picks the top outright-win side. No reserving — confidence
              floor not used.
            </p>
          )}

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

  const strategyOptions: { value: LmsReserveStrategy; label: string }[] = [
    { value: "safest", label: "Safest" },
    { value: "manual", label: "Manual" },
    { value: "smart", label: "Smart" },
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
            options={strategyOptions}
            value={strategy}
            onValueChange={(v) => setStrategyLocal(v as LmsReserveStrategy)}
            fullWidth
          />
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
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  competitionId: number;
  onAdded: () => void;
}) {
  const [label, setLabel] = useState("");
  const [strategy, setStrategyLocal] = useState<LmsReserveStrategy>("smart");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setLabel("");
    setStrategyLocal("smart");
    setError(null);
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
        reset();
        onAdded();
      } else {
        setError(res.error ?? "Could not add entry.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const strategyOptions: { value: LmsReserveStrategy; label: string }[] = [
    { value: "safest", label: "Safest" },
    { value: "manual", label: "Manual" },
    { value: "smart", label: "Smart" },
  ];

  return (
    <BottomSheet
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Add Entry"
    >
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
            options={strategyOptions}
            value={strategy}
            onValueChange={(v) => setStrategyLocal(v as LmsReserveStrategy)}
            fullWidth
          />
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
}: {
  gw: number | null;
  onClose: () => void;
  fixtureProbs: PlannerFixtureProb[];
  teams: PlannerTeam[];
  excludedTeamIds: number[];
  onSelect: (gw: number, teamId: number) => void;
}) {
  const teamMap = useMemo(
    () => new Map(teams.map((t) => [t.id, t])),
    [teams],
  );

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

  return (
    <BottomSheet
      open={gw != null}
      onClose={onClose}
      title={gw != null ? `Override GW${gw} pick` : undefined}
    >
      <div className="space-y-2">
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
      </div>
    </BottomSheet>
  );
}
