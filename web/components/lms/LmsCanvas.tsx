"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Clock, Lock } from "lucide-react";
import {
  Badge,
  BottomSheet,
  Button,
  Card,
  ClubBadge,
  ProbBar,
  SegmentedControl,
  StatBlock,
} from "@/components/ui";
import { rankedLmsPicks, buildForwardPlanPlaceholder } from "@/lib/lms";
import { saveLmsPick } from "@/app/actions";
import { formatPct } from "@/lib/format";
import type {
  Gameweek,
  LmsEntry,
  LmsFixtureOption,
  Team,
} from "@/lib/types";

export interface LmsCanvasProps {
  competitionName: string;
  /** Current qualifying (7+ game) round, or null when none is eligible. */
  roundGw: number | null;
  entries: LmsEntry[];
  /** Full win-prob-ranked backing options for `roundGw` (real model data). */
  options: LmsFixtureOption[];
  allTeams: Team[];
  /** Upcoming gameweeks (incl. sub-7 rounds) driving the forward-plan timeline. */
  upcoming: Gameweek[];
  /** Competition-wide survivor counts — no data source yet. */
  survivorsPlaceholder: number;
  totalEntrantsPlaceholder: number;
}

// The backed team's own win / draw / loss view of a fixture (probs are stored
// home-team first, so flip when we're backing the away side).
function backedView(o: LmsFixtureOption) {
  const p = o.probs;
  const win = o.pickIsHome ? p?.p_home : p?.p_away;
  const loss = o.pickIsHome ? p?.p_away : p?.p_home;
  const draw = p?.p_draw ?? null;
  const opponent = o.pickIsHome ? o.awayTeam : o.homeTeam;
  return { win: win ?? null, draw, loss: loss ?? null, opponent, venue: o.pickIsHome ? "H" : "A" };
}

export function LmsCanvas({
  competitionName,
  roundGw,
  entries,
  options,
  allTeams,
  upcoming,
  survivorsPlaceholder,
  totalEntrantsPlaceholder,
}: LmsCanvasProps) {
  const router = useRouter();
  const [entryId, setEntryId] = useState(entries[0]?.id ?? "entry-1");
  const [selectedFixtureId, setSelectedFixtureId] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewTeam, setPreviewTeam] = useState<Team | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [demoNote, setDemoNote] = useState(false);

  const entry = entries.find((e) => e.id === entryId) ?? entries[0];

  // Per-entry derived state. Used teams are entry-specific — this is what keeps
  // the entries independent and keeps a spent team out of the recommendations.
  const usedIds = useMemo(
    () =>
      new Set(
        entry.picks
          .map((p) => p.team?.fpl_id)
          .filter((id): id is number => id != null),
      ),
    [entry],
  );
  const usedCodes = useMemo(
    () =>
      new Set(
        entry.picks
          .map((p) => p.team?.short_name)
          .filter((c): c is string => !!c),
      ),
    [entry],
  );

  const ranked = useMemo(
    () => rankedLmsPicks(options, [...usedIds], 3),
    [options, usedIds],
  );

  const availableTeams = useMemo(
    () => allTeams.filter((t) => !usedIds.has(t.fpl_id)),
    [allTeams, usedIds],
  );

  const forwardPlan = useMemo(
    () => buildForwardPlanPlaceholder(upcoming, usedCodes, availableTeams),
    [upcoming, usedCodes, availableTeams],
  );

  // The pick already locked for this round in this entry (draw = OUT, so this
  // can't be changed once set).
  const lockedForRound =
    roundGw != null ? entry.picks.find((p) => p.roundGw === roundGw) : undefined;

  // Which of the top-3 the submit affordance targets (defaults to #1).
  const selected =
    ranked.find((o) => o.fixture.fpl_id === selectedFixtureId) ?? ranked[0] ?? null;

  const canSubmit =
    roundGw != null && !entry.eliminated && !lockedForRound && selected != null;

  async function onConfirm() {
    if (!selected?.pickTeam || roundGw == null) return;

    if (!entry.persisted) {
      // Second entries have no DB dimension yet — stubbed. // TODO wire.
      setConfirmOpen(false);
      setDemoNote(true);
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const res = await saveLmsPick({
        roundGw,
        teamId: selected.pickTeam.fpl_id,
      });
      if (res.ok) {
        setConfirmOpen(false);
        router.refresh();
      } else {
        setSaveError(res.error ?? "Could not record your pick.");
      }
    } catch {
      setSaveError("Could not record your pick. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const entryOptions = entries.map((e) => ({
    value: e.id,
    label: e.label,
  }));

  return (
    <div className="pb-24 md:pb-8">
      {/* Competition selector */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="lms-competition">
          Competition
        </label>
        <select
          id="lms-competition"
          className="h-9 rounded-lg border border-strong bg-surface-2 px-3 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          defaultValue="sphinx"
        >
          <option value="sphinx">{competitionName}</option>
        </select>
        <SegmentedControl
          aria-label="Entry"
          options={entryOptions}
          value={entry.id}
          onValueChange={(v) => {
            setEntryId(v);
            setSelectedFixtureId(null);
            setSaveError(null);
            setDemoNote(false);
          }}
        />
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
        {/* Main column: overview + top-3 */}
        <div className="space-y-4">
          <StatusCard
            roundGw={roundGw}
            entry={entry}
            recommended={ranked[0] ?? null}
            survivors={survivorsPlaceholder}
            totalEntrants={totalEntrantsPlaceholder}
          />
          <Top3Section
            roundGw={roundGw}
            entry={entry}
            ranked={ranked}
            selectedFixtureId={selected?.fixture.fpl_id ?? null}
            onSelect={(id) => setSelectedFixtureId(id)}
            lockedForRound={!!lockedForRound}
          />
        </div>

        {/* Side column: used & remaining */}
        <div className="mt-4 lg:mt-0">
          <UsedRemainingSection
            entry={entry}
            availableTeams={availableTeams}
            onPreview={(t) => setPreviewTeam(t)}
          />
        </div>
      </div>

      {/* Forward plan spans full width, below both columns */}
      <ForwardPlanSection plan={forwardPlan} />

      {demoNote && !entry.persisted && (
        <p className="mt-4 rounded-lg border border-subtle bg-surface p-3 text-xs text-muted">
          Preview only — {entry.label} isn&apos;t persisted yet. Recording extra
          entries needs an entry dimension on <code>lms_picks</code>{" "}
          (<code>{"// TODO wire"}</code>).
        </p>
      )}

      {/* Sticky submit bar (mobile) / inline (desktop) */}
      <SubmitBar
        roundGw={roundGw}
        entry={entry}
        selected={selected}
        lockedForRound={lockedForRound ?? null}
        canSubmit={canSubmit}
        onOpen={() => {
          setSaveError(null);
          setConfirmOpen(true);
        }}
      />

      {/* Frame 5 — submit confirm */}
      <BottomSheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm your pick"
      >
        {selected?.pickTeam && roundGw != null ? (
          <ConfirmBody
            roundGw={roundGw}
            option={selected}
            saving={saving}
            error={saveError}
            persisted={entry.persisted}
            onConfirm={onConfirm}
            onCancel={() => setConfirmOpen(false)}
          />
        ) : (
          <p className="text-sm text-secondary">No pick available to confirm.</p>
        )}
      </BottomSheet>

      {/* Fixture preview for an available team (Frame 3 tap target) */}
      <BottomSheet
        open={previewTeam != null}
        onClose={() => setPreviewTeam(null)}
        title={previewTeam ? `${previewTeam.name} · fixture` : undefined}
      >
        {previewTeam && (
          <TeamFixturePreview
            team={previewTeam}
            roundGw={roundGw}
            options={options}
          />
        )}
      </BottomSheet>
    </div>
  );
}

// ---------- Frame 1: overview / status ----------

function StatusCard({
  roundGw,
  entry,
  recommended,
  survivors,
  totalEntrants,
}: {
  roundGw: number | null;
  entry: LmsEntry;
  recommended: LmsFixtureOption | null;
  survivors: number;
  totalEntrants: number;
}) {
  const status = entry.eliminated ? "Eliminated" : "Alive";
  const rec = recommended ? backedView(recommended) : null;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">
              {entry.label}
            </p>
            <p className="mt-0.5 text-lg font-bold text-primary">
              {roundGw != null ? `Round GW${roundGw}` : "No eligible round"}{" "}
              <span className="text-muted">·</span>{" "}
              <span className={entry.eliminated ? "text-danger" : "text-success"}>
                {status}
              </span>
            </p>
          </div>
          <Badge tone={entry.eliminated ? "danger" : "success"}>{status}</Badge>
        </div>

        <div className="mt-4 flex items-end justify-between gap-4">
          <StatBlock
            label="Survivors"
            value={survivors}
            unit={`/ ${totalEntrants}`}
            emphasis="accent"
            size="lg"
          />
          <StatBlock
            label="Teams used"
            value={entry.picks.length}
            unit="/ 20"
            align="right"
          />
        </div>
      </Card>

      {/* Persistent Draw = OUT reminder */}
      <div
        className="rounded-lg border border-[rgba(244,63,94,0.40)] bg-[rgba(244,63,94,0.10)] px-4 py-3 text-center"
        role="note"
      >
        <p className="text-sm font-bold uppercase tracking-wide text-danger">
          ⚠️ Draw = OUT
        </p>
        <p className="mt-0.5 text-xs text-danger">
          Your team must WIN outright. A draw eliminates you just like a loss.
        </p>
      </div>

      {/* Recommended-pick preview */}
      {rec && recommended?.pickTeam ? (
        <Card selected>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <ClubBadge
                code={recommended.pickTeam.short_name}
                size={44}
                state="recommended"
              />
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Recommended pick
                </p>
                <p className="text-base font-bold text-primary">
                  {recommended.pickTeam.name}{" "}
                  <span className="text-sm font-medium text-secondary">
                    ({rec.venue}) v {rec.opponent?.short_name ?? "TBD"}
                  </span>
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xl font-bold tnum text-accent">
                {formatPct(rec.win)}
              </p>
              <a
                href="#lms-top3"
                className="text-xs font-semibold text-accent hover:underline"
              >
                See all 3 →
              </a>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-secondary">
            No recommended pick yet — win probabilities appear once the model has
            run for this round.
          </p>
        </Card>
      )}
    </div>
  );
}

// ---------- Frame 2: top-3 picks ----------

function Top3Section({
  roundGw,
  entry,
  ranked,
  selectedFixtureId,
  onSelect,
  lockedForRound,
}: {
  roundGw: number | null;
  entry: LmsEntry;
  ranked: LmsFixtureOption[];
  selectedFixtureId: number | null;
  onSelect: (fixtureId: number) => void;
  lockedForRound: boolean;
}) {
  return (
    <section id="lms-top3" className="scroll-mt-20">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Top 3 picks{roundGw != null ? ` · GW${roundGw}` : ""}
        </h2>
        <span className="text-xs text-muted">{entry.label}</span>
      </div>

      {ranked.length === 0 ? (
        <Card>
          <p className="text-sm text-secondary">
            {entry.eliminated
              ? "This entry is out — no picks to rank."
              : "No qualifying picks yet. Ranked options appear once the model has priced this round's fixtures."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {ranked.map((o, i) => (
            <PickCard
              key={o.fixture.fpl_id}
              option={o}
              rank={i + 1}
              selected={o.fixture.fpl_id === selectedFixtureId}
              onSelect={() => onSelect(o.fixture.fpl_id)}
              disabled={lockedForRound || entry.eliminated}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PickCard({
  option,
  rank,
  selected,
  onSelect,
  disabled,
}: {
  option: LmsFixtureOption;
  rank: number;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  const v = backedView(option);
  const team = option.pickTeam;

  if (rank === 1) {
    return (
      <Card selected={selected} className="relative">
        <button
          type="button"
          onClick={onSelect}
          disabled={disabled}
          className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed"
          aria-label={`Choose ${team?.name ?? "pick"} as your pick`}
        />
        <div className="relative z-10 pointer-events-none">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <ClubBadge code={team?.short_name} size={64} state="recommended" />
              <span className="text-lg font-bold text-muted">v</span>
              <ClubBadge code={v.opponent?.short_name} size={44} />
            </div>
            <Badge tone="accent">#1 · Safest banker</Badge>
          </div>

          <div className="mt-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-2xl font-bold text-primary">
                {team?.name ?? "TBD"}{" "}
                <span className="text-base font-medium text-secondary">
                  ({v.venue})
                </span>
              </p>
              <p className="mt-0.5 text-sm text-secondary">
                Strongest outright-win probability of any unused side this round.
              </p>
            </div>
            <div className="text-right">
              <span className="block text-4xl font-black leading-none tnum text-accent">
                {formatPct(v.win)}
              </span>
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                outright win
              </span>
            </div>
          </div>

          <div className="mt-3">
            <ProbBar home={v.win} draw={v.draw} away={v.loss} showLabels />
          </div>
        </div>
      </Card>
    );
  }

  // #2 and #3 compact.
  const reserveFlag = rank === 3;
  return (
    <Card selected={selected} padding="sm">
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        className="flex w-full items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-md disabled:cursor-not-allowed"
      >
        <span className="w-5 shrink-0 text-center text-sm font-bold text-muted">
          {rank}
        </span>
        <ClubBadge code={team?.short_name} size={32} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-primary">
            {team?.name ?? "TBD"}{" "}
            <span className="font-medium text-secondary">({v.venue})</span>{" "}
            <span className="text-xs text-muted">
              v {v.opponent?.short_name ?? "TBD"}
            </span>
          </p>
          {reserveFlag && (
            <span className="mt-0.5 inline-block">
              <Badge tone="warning">Consider reserving — needed later</Badge>
            </span>
          )}
        </div>
        <span className="shrink-0 text-right">
          <span className="block text-base font-bold tnum text-accent">
            {formatPct(v.win)}
          </span>
          <span className="text-[11px] text-muted">win</span>
        </span>
      </button>
    </Card>
  );
}

// ---------- Frame 3: used & remaining ----------

function UsedRemainingSection({
  entry,
  availableTeams,
  onPreview,
}: {
  entry: LmsEntry;
  availableTeams: Team[];
  onPreview: (team: Team) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
          Used this season
        </h2>
        {entry.picks.length === 0 ? (
          <Card>
            <p className="text-sm text-secondary">
              No teams used yet — every side is still available.
            </p>
          </Card>
        ) : (
          <div className="flex flex-wrap gap-3">
            {entry.picks.map((p) => (
              <div
                key={`${p.roundGw}-${p.team?.fpl_id ?? "x"}`}
                className="flex flex-col items-center gap-1"
              >
                <ClubBadge
                  code={p.team?.short_name}
                  size={44}
                  state="used"
                  title={`${p.team?.name ?? "Team"} · GW${p.roundGw}`}
                />
                <span className="text-[11px] font-medium text-muted">
                  GW{p.roundGw}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
          Available · {availableTeams.length}
        </h2>
        {availableTeams.length === 0 ? (
          <Card>
            <p className="text-sm text-secondary">No teams loaded yet.</p>
          </Card>
        ) : (
          <div className="flex flex-wrap gap-2.5">
            {availableTeams.map((t) => (
              <button
                key={t.fpl_id}
                type="button"
                onClick={() => onPreview(t)}
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label={`Preview ${t.name} fixture`}
              >
                <ClubBadge code={t.short_name} size={32} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Frame 4: forward plan ----------

function ForwardPlanSection({
  plan,
}: {
  plan: ReturnType<typeof buildForwardPlanPlaceholder>;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Forward plan · next 5 qualifying rounds
        </h2>
        <span className="text-xs text-muted">provisional</span>
      </div>

      {plan.length === 0 ? (
        <Card>
          <p className="text-sm text-secondary">
            No upcoming rounds loaded yet.
          </p>
        </Card>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2 md:overflow-x-visible">
          {plan.map((r) => {
            if (!r.qualifies) {
              return (
                <div
                  key={r.round}
                  className="flex w-24 shrink-0 flex-col items-center justify-center rounded-lg border border-dashed border-subtle bg-surface/50 p-3 text-center opacity-60 md:w-auto md:flex-none md:basis-24"
                >
                  <span className="text-xs font-semibold text-muted">
                    GW{r.round}
                  </span>
                  <span className="mt-1 text-[11px] text-muted">
                    Skipped · under 7
                  </span>
                  <span className="text-[11px] text-muted">
                    {r.numFixtures ?? "—"} games
                  </span>
                </div>
              );
            }

            const reserved = r.reserved[0];
            if (reserved) {
              return (
                <Card
                  key={r.round}
                  padding="sm"
                  className="w-52 shrink-0 md:w-auto md:min-w-0 md:flex-1"
                  style={{ boxShadow: "inset 0 0 0 1.5px var(--warning)" }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wide text-warning">
                      GW{r.round}
                    </span>
                    <Clock className="h-4 w-4 text-warning" aria-hidden />
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <ClubBadge code={reserved.code} size={32} state="reserved" />
                    <span className="text-sm font-semibold text-primary">
                      Reserve
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-secondary">
                    {reserved.reason}.
                  </p>
                </Card>
              );
            }

            return (
              <Card
                key={r.round}
                padding="sm"
                className="w-52 shrink-0 md:w-auto md:min-w-0 md:flex-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wide text-muted">
                    GW{r.round}
                  </span>
                  {r.winProb != null && (
                    <span className="text-sm font-bold tnum text-accent">
                      {formatPct(r.winProb)}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <ClubBadge code={r.provisionalPick?.code} size={32} />
                  <span className="text-sm font-semibold text-primary">
                    {r.provisionalPick
                      ? `${r.provisionalPick.code} (${r.provisionalPick.isHome ? "H" : "A"})`
                      : "TBD"}
                  </span>
                </div>
                <p className="mt-1.5 text-xs text-secondary">{r.reason}</p>
              </Card>
            );
          })}
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted">
        Provisional allocation — the season-long reservation engine isn&apos;t
        wired yet.
      </p>
    </section>
  );
}

// ---------- Submit bar + confirm ----------

function SubmitBar({
  roundGw,
  entry,
  selected,
  lockedForRound,
  canSubmit,
  onOpen,
}: {
  roundGw: number | null;
  entry: LmsEntry;
  selected: LmsFixtureOption | null;
  lockedForRound: { team: Team | null } | null;
  canSubmit: boolean;
  onOpen: () => void;
}) {
  const v = selected ? backedView(selected) : null;

  return (
    <div className="fixed inset-x-0 bottom-16 z-30 border-t border-subtle bg-raised/95 px-4 py-3 backdrop-blur md:static md:mt-6 md:rounded-lg md:border md:bg-surface md:px-4 md:shadow-card">
      <div className="mx-auto flex max-w-[1100px] items-center justify-between gap-3">
        <div className="min-w-0">
          {lockedForRound ? (
            <p className="flex items-center gap-1.5 text-sm font-semibold text-primary">
              <Lock className="h-4 w-4 text-muted" aria-hidden />
              Locked: {lockedForRound.team?.name ?? "pick"} · GW{roundGw}
            </p>
          ) : entry.eliminated ? (
            <p className="text-sm font-semibold text-danger">
              {entry.label} eliminated
            </p>
          ) : selected?.pickTeam && v ? (
            <p className="truncate text-sm text-secondary">
              Backing{" "}
              <span className="font-semibold text-primary">
                {selected.pickTeam.name} ({v.venue})
              </span>{" "}
              · {formatPct(v.win)} win
            </p>
          ) : (
            <p className="text-sm text-secondary">No pick available</p>
          )}
        </div>
        <Button onClick={onOpen} disabled={!canSubmit}>
          {lockedForRound ? "Pick locked" : "Submit pick"}
        </Button>
      </div>
    </div>
  );
}

function ConfirmBody({
  roundGw,
  option,
  saving,
  error,
  persisted,
  onConfirm,
  onCancel,
}: {
  roundGw: number;
  option: LmsFixtureOption;
  saving: boolean;
  error: string | null;
  persisted: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const v = backedView(option);
  const team = option.pickTeam;

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <ClubBadge code={team?.short_name} size={44} state="recommended" />
        <div>
          <p className="text-base font-bold text-primary">
            {team?.name ?? "TBD"} ({v.venue})
          </p>
          <p className="text-sm text-secondary">
            v {v.opponent?.name ?? "TBD"} · {formatPct(v.win)} win
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-[rgba(244,63,94,0.40)] bg-[rgba(244,63,94,0.10)] p-3">
        <p className="text-sm font-bold uppercase tracking-wide text-danger">
          Draw = OUT
        </p>
        <p className="mt-0.5 text-sm text-danger">
          This locks your GW{roundGw} pick — {team?.name ?? "your team"} ({v.venue})
          — and can&apos;t be changed.
        </p>
      </div>

      {!persisted && (
        <p className="mt-3 text-xs text-muted">
          Preview only — this entry isn&apos;t persisted yet.
        </p>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-4 flex gap-2">
        <Button onClick={onConfirm} disabled={saving} fullWidth>
          {saving ? "Recording…" : "Confirm pick"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------- Team fixture preview (Frame 3 tap) ----------

function TeamFixturePreview({
  team,
  roundGw,
  options,
}: {
  team: Team;
  roundGw: number | null;
  options: LmsFixtureOption[];
}) {
  const opt = options.find(
    (o) =>
      o.fixture.home_team === team.fpl_id ||
      o.fixture.away_team === team.fpl_id,
  );

  if (!opt) {
    return (
      <p className="text-sm text-secondary">
        No fixture for {team.name}
        {roundGw != null ? ` in GW${roundGw}` : ""}.
      </p>
    );
  }

  const isHome = opt.fixture.home_team === team.fpl_id;
  const p = opt.probs;
  const win = isHome ? p?.p_home : p?.p_away;
  const loss = isHome ? p?.p_away : p?.p_home;
  const opponent = isHome ? opt.awayTeam : opt.homeTeam;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ClubBadge code={team.short_name} size={44} />
          <span className="text-lg font-bold text-muted">v</span>
          <ClubBadge code={opponent?.short_name} size={44} />
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold tnum text-accent">{formatPct(win)}</p>
          <p className="text-xs text-muted">win ({isHome ? "H" : "A"})</p>
        </div>
      </div>
      <p className="mb-2 text-sm text-secondary">
        {team.name} v {opponent?.name ?? "TBD"}
        {roundGw != null ? ` · GW${roundGw}` : ""}
      </p>
      <ProbBar home={win} draw={p?.p_draw} away={loss} showLabels />
    </div>
  );
}
