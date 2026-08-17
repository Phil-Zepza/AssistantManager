"use client";

import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import { saveSquad } from "@/app/actions";
import {
  Badge,
  Button,
  Callout,
  StatBlock,
} from "@/components/ui";
import { formatPrice } from "@/lib/format";
import {
  DEFAULT_FORMATION,
  formationCounts,
  PITCH_ROWS,
  type Formation,
} from "@/lib/pitch";
import {
  BUDGET_CAP_TENTHS,
  MAX_PER_CLUB,
  POSITION_ORDER,
  POSITION_QUOTA,
  SQUAD_SIZE,
  validateSquad,
  type SquadMember,
} from "@/lib/squad";
import type {
  PickPoolEntry,
  Position,
  SquadEntry,
  SquadSelection,
} from "@/lib/types";
import { BudgetBar } from "./BudgetBar";
import { FormationControl } from "./FormationControl";
import { Pitch, type PitchRow, type PitchSlot } from "./Pitch";
import { PlayerDecisionSheet } from "./PlayerDecisionSheet";
import {
  PlayerSearchSheet,
  type AddValidation,
} from "./PlayerSearchSheet";

export interface PitchPlannerProps {
  gw: number;
  pool: PickPoolEntry[];
  initialSelections: SquadSelection[];
  initialFormation?: Formation;
}

function epOf(e: PickPoolEntry | undefined): number {
  return e?.expected_points ?? -Infinity;
}

interface Allocation {
  rows: PitchRow[];
  bench: PitchSlot[];
  entries: SquadEntry[];
  selections: SquadSelection[];
  members: SquadMember[];
}

// Deterministically lay the picked players onto the pitch for a formation:
// within each position the highest-EP players start (up to the formation count),
// the rest fill the bench; empty positions become "Add {POS}" tokens. Captain =
// top-EP starter, vice = second — a read-only *suggested* verdict, auto-derived
// so the plan is always valid to save (no set-captain control exists).
function buildAllocation(
  pickedIds: number[],
  poolById: Map<number, PickPoolEntry>,
  formation: Formation,
): Allocation {
  const counts = formationCounts(formation);

  const byPos: Record<Position, PickPoolEntry[]> = {
    GK: [],
    DEF: [],
    MID: [],
    FWD: [],
  };
  for (const id of pickedIds) {
    const e = poolById.get(id);
    if (e) byPos[e.player.position].push(e);
  }
  for (const pos of POSITION_ORDER) byPos[pos].sort((a, b) => epOf(b) - epOf(a));

  const startersByPos = {} as Record<Position, PickPoolEntry[]>;
  const benchByPos = {} as Record<Position, PickPoolEntry[]>;
  for (const pos of POSITION_ORDER) {
    startersByPos[pos] = byPos[pos].slice(0, counts[pos]);
    benchByPos[pos] = byPos[pos].slice(counts[pos]);
  }

  const allStarters = POSITION_ORDER.flatMap((pos) => startersByPos[pos]);
  const byEp = allStarters.slice().sort((a, b) => epOf(b) - epOf(a));
  const captainId = byEp[0]?.player.fpl_id ?? null;
  const viceId = byEp[1]?.player.fpl_id ?? null;

  const entries: SquadEntry[] = [];
  const selections: SquadSelection[] = [];
  const members: SquadMember[] = [];
  const entryById = new Map<number, SquadEntry>();

  const push = (e: PickPoolEntry, onBench: boolean) => {
    const isCaptain = e.player.fpl_id === captainId && !onBench;
    const isVice = e.player.fpl_id === viceId && !onBench;
    const se: SquadEntry = {
      player: e.player,
      team: e.team,
      expected_points: e.expected_points,
      is_captain: isCaptain,
      is_vice: isVice,
      on_bench: onBench,
    };
    entries.push(se);
    entryById.set(e.player.fpl_id, se);
    selections.push({
      playerId: e.player.fpl_id,
      onBench,
      isCaptain,
      isVice,
    });
    members.push({
      playerId: e.player.fpl_id,
      position: e.player.position,
      teamId: e.player.team_id,
      onBench,
      isCaptain,
      isVice,
    });
  };
  for (const pos of POSITION_ORDER) startersByPos[pos].forEach((e) => push(e, false));
  for (const pos of POSITION_ORDER) benchByPos[pos].forEach((e) => push(e, true));

  const rows: PitchRow[] = PITCH_ROWS.map((pos) => {
    const slots: PitchSlot[] = startersByPos[pos].map((e) => {
      const se = entryById.get(e.player.fpl_id)!;
      return { kind: "filled", entry: se, isCaptain: se.is_captain };
    });
    for (let i = startersByPos[pos].length; i < counts[pos]; i++) {
      slots.push({ kind: "empty", position: pos });
    }
    return { position: pos, slots };
  });

  const bench: PitchSlot[] = [];
  for (const pos of POSITION_ORDER) {
    const benchSlots = POSITION_QUOTA[pos] - counts[pos];
    const players = benchByPos[pos];
    for (let i = 0; i < benchSlots; i++) {
      const e = players[i];
      if (e) {
        const se = entryById.get(e.player.fpl_id)!;
        bench.push({ kind: "filled", entry: se, isCaptain: false });
      } else {
        bench.push({ kind: "empty", position: pos });
      }
    }
  }

  return { rows, bench, entries, selections, members };
}

export function PitchPlanner({
  gw,
  pool,
  initialSelections,
  initialFormation,
}: PitchPlannerProps) {
  const poolById = useMemo(() => {
    const m = new Map<number, PickPoolEntry>();
    for (const e of pool) m.set(e.player.fpl_id, e);
    return m;
  }, [pool]);

  const [pickedIds, setPickedIds] = useState<number[]>(() =>
    initialSelections
      .filter((s) => poolById.has(s.playerId))
      .map((s) => s.playerId),
  );
  const [formation, setFormation] = useState<Formation>(
    initialFormation ?? DEFAULT_FORMATION,
  );

  const [searchPos, setSearchPos] = useState<Position | null>(null);
  const [decisionEntry, setDecisionEntry] = useState<SquadEntry | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pickedSet = useMemo(() => new Set(pickedIds), [pickedIds]);

  const alloc = useMemo(
    () => buildAllocation(pickedIds, poolById, formation),
    [pickedIds, poolById, formation],
  );

  // ---- counts / budget ----
  const posCounts = useMemo(() => {
    const c: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const id of pickedIds) {
      const e = poolById.get(id);
      if (e) c[e.player.position] += 1;
    }
    return c;
  }, [pickedIds, poolById]);

  const clubCounts = useMemo(() => {
    const c = new Map<number, number>();
    for (const id of pickedIds) {
      const t = poolById.get(id)?.player.team_id;
      if (t != null) c.set(t, (c.get(t) ?? 0) + 1);
    }
    return c;
  }, [pickedIds, poolById]);

  const value = useMemo(
    () => pickedIds.reduce((s, id) => s + (poolById.get(id)?.player.price ?? 0), 0),
    [pickedIds, poolById],
  );
  const overBudgetBy = Math.max(0, value - BUDGET_CAP_TENTHS);
  const clubCapOk = [...clubCounts.values()].every((n) => n <= MAX_PER_CLUB);

  const errors = useMemo(
    () => validateSquad(alloc.members),
    [alloc.members],
  );
  const canSave = errors.length === 0 && !saving;

  // ---- mutations (edit the local plan only — never FPL) ----
  function addPlayer(entry: PickPoolEntry) {
    const id = entry.player.fpl_id;
    if (pickedSet.has(id)) return;
    setPickedIds((prev) => [...prev, id]);
  }

  function removePlayer(entry: PickPoolEntry) {
    const id = entry.player.fpl_id;
    setPickedIds((prev) => prev.filter((x) => x !== id));
  }

  function validateAdd(entry: PickPoolEntry): AddValidation {
    const p = entry.player;
    if (pickedSet.has(p.fpl_id)) return { ok: false, reason: "Added" };
    if (pickedIds.length >= SQUAD_SIZE) return { ok: false, reason: "Squad full" };
    if (posCounts[p.position] >= POSITION_QUOTA[p.position]) {
      return { ok: false, reason: `${p.position} full` };
    }
    if (
      p.team_id != null &&
      (clubCounts.get(p.team_id) ?? 0) >= MAX_PER_CLUB
    ) {
      return {
        ok: false,
        reason: `Already ${MAX_PER_CLUB} from ${entry.team?.short_name ?? "club"}`,
      };
    }
    return { ok: true, reason: null };
  }

  async function onSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveSquad({ gw, selections: alloc.selections });
      // saveSquad redirects to "/" on success.
    } catch {
      setSaveError("Could not save your plan. Please try again.");
      setSaving(false);
    }
  }

  const saveBtn = (
    <Button
      onClick={onSave}
      disabled={!canSave}
      fullWidth
      aria-label="Save plan"
    >
      {saving ? "Saving…" : "Save plan"}
    </Button>
  );

  return (
    <div>
      {/* ---- mobile controls (sticky) ---- */}
      <div className="sticky top-14 z-10 -mx-4 space-y-2 border-b border-subtle bg-base/95 px-4 py-2.5 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:py-0">
        <div className="md:hidden">
          <BudgetBar value={value} count={pickedIds.length} />
        </div>
        <div className="flex items-center justify-between gap-2 md:hidden">
          <FormationControl value={formation} onChange={setFormation} />
          <span className="text-xs text-muted">
            {overBudgetBy > 0 ? (
              <span className="font-semibold text-danger">
                {formatPrice(overBudgetBy)} over
              </span>
            ) : (
              `${formatPrice(BUDGET_CAP_TENTHS - value)} left`
            )}
          </span>
        </div>
      </div>

      {/* ---- desktop split: pitch + right panel ---- */}
      <div className="mt-3 gap-6 md:grid md:grid-cols-[minmax(0,1fr)_260px]">
        <div className="mx-auto w-full max-w-xl">
          <Pitch
            rows={alloc.rows}
            bench={alloc.bench}
            onSelectPlayer={setDecisionEntry}
            onAddSlot={setSearchPos}
          />
          {errors.length > 0 && pickedIds.length > 0 && (
            <ul className="mt-3 space-y-0.5 text-xs text-secondary">
              {errors.slice(0, 3).map((e) => (
                <li key={e}>• {e}</li>
              ))}
            </ul>
          )}
          {saveError && (
            <p className="mt-2 text-xs font-medium text-danger">{saveError}</p>
          )}
          <div className="mt-4 md:hidden">{saveBtn}</div>
        </div>

        {/* right panel (desktop) */}
        <aside className="hidden md:block">
          <div className="sticky top-20 space-y-4 rounded-xl border border-subtle bg-surface p-4">
            <StatBlock
              label="Budget remaining"
              value={`${overBudgetBy > 0 ? "−" : ""}${formatPrice(
                Math.abs(BUDGET_CAP_TENTHS - value),
              )}`}
              unit={`of ${formatPrice(BUDGET_CAP_TENTHS)}`}
              size="lg"
              emphasis={overBudgetBy > 0 ? "none" : "accent"}
              className={overBudgetBy > 0 ? "[&>div>span:first-child]:text-danger" : undefined}
            />
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="gray">Value {formatPrice(value)}</Badge>
              <Badge tone="gray">{pickedIds.length}/{SQUAD_SIZE} filled</Badge>
              <Badge tone={clubCapOk ? "success" : "danger"}>
                {clubCapOk ? "Max 3 per club OK" : "Over 3 from a club"}
              </Badge>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                Formation
              </p>
              <FormationControl
                value={formation}
                onChange={setFormation}
                variant="grid"
              />
            </div>
            {saveBtn}
            <p className="text-[11px] leading-relaxed text-muted">
              Saving stores this plan to your squad mirror only — it never pushes
              to FPL.
            </p>
          </div>
        </aside>
      </div>

      {pickedIds.length === 0 && (
        <Callout tone="info" className="mt-4" icon={<Info className="h-5 w-5" />}>
          Tap a{" "}
          <span className="font-semibold text-primary">+ slot</span> to add a
          player. Build all 15 (2 GK · 5 DEF · 5 MID · 3 FWD), then Save plan.
        </Callout>
      )}

      {/* ---- sheets ---- */}
      {searchPos && (
        <PlayerSearchSheet
          open={searchPos != null}
          onClose={() => setSearchPos(null)}
          position={searchPos}
          pool={pool}
          picked={pickedSet}
          validateAdd={validateAdd}
          overBudgetBy={overBudgetBy}
          onAdd={addPlayer}
          onRemove={removePlayer}
        />
      )}

      <PlayerDecisionSheet
        open={decisionEntry != null}
        onClose={() => setDecisionEntry(null)}
        entry={decisionEntry}
        entries={alloc.entries}
        pool={pool}
      />
    </div>
  );
}
